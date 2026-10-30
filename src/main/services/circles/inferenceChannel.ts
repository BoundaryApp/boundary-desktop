/**
 * The `inference` channel between two members' devices (ADR 0034 §2): one Protomux channel per
 * connection, sharing the muxer Corestore replicates over. Either side can ask the other's
 * gateway for a model and serve requests to its own.
 *
 * Every message goes over the encrypted stream, so it arrives once and in order. Secret-stream's
 * unordered `send`/`trySend` are never used: they can lose, repeat and reorder messages.
 */
import { Readable } from 'node:stream';
import { buffer, json, uint, type Encoding, type State } from 'compact-encoding';
import Protomux, { type ProtomuxChannel, type ProtomuxMessage } from 'protomux';
import type { SecretStream } from 'hyperswarm';
import type { GatewayRequest, InferenceGateway } from './inferenceGateway';

const INFERENCE_PROTOCOL = 'boundary/inference/1';

/** What a consumer gets back: the provider's status and a stream of its reply bytes. */
export interface SharedModelResponse {
  status: number;
  contentType: string;
  body: Readable;
}

export type SharedModelRequest = Omit<GatewayRequest, 'id'>;

interface Head {
  id: number;
  status: number;
  contentType: string;
}

interface Chunk {
  id: number;
  data: Buffer;
}

interface End {
  id: number;
  error?: string;
}

const chunkEncoding: Encoding<Chunk> = {
  preencode(state: State, value: Chunk) {
    uint.preencode(state, value.id);
    buffer.preencode(state, value.data);
  },
  encode(state: State, value: Chunk) {
    uint.encode(state, value.id);
    buffer.encode(state, value.data);
  },
  decode(state: State): Chunk {
    return { id: uint.decode(state), data: buffer.decode(state) ?? Buffer.alloc(0) };
  },
};

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isString = (value: unknown): value is string => typeof value === 'string';

/** The other side is a member's device, but its messages are still checked. */
function asRequest(value: unknown): GatewayRequest | null {
  const request = value as GatewayRequest;
  if (typeof request !== 'object' || request === null) return null;
  if (!isId(request.id) || !isString(request.circle) || !isString(request.method) || !isString(request.path)) return null;
  if (request.body !== undefined && !isString(request.body)) return null;
  return { id: request.id, circle: request.circle, method: request.method, path: request.path, body: request.body };
}

interface Pending {
  head: (response: SharedModelResponse) => void;
  fail: (error: Error) => void;
  body: Readable | null;
  /** For diagnostics. */
  sentAt: number;
  bytes: number;
  chunks: number;
  firstChunkMs: number | null;
}

/** Diagnostics events (metadata only). */
export type LinkDiag = (event: string, data: Record<string, unknown>) => void;

/**
 * Call `onOpen` when the other side opens the channel first. Without this Protomux turns the
 * open down at once, and the two sides learn that they're members at different moments.
 */
export function onInferenceOpen(connection: SecretStream, onOpen: () => void): void {
  Protomux.from(connection).pair({ protocol: INFERENCE_PROTOCOL }, onOpen);
}

export class InferenceLink {
  private readonly channel: ProtomuxChannel;
  private readonly send: {
    request: ProtomuxMessage<GatewayRequest>;
    cancel: ProtomuxMessage<{ id: number }>;
    head: ProtomuxMessage<Head>;
    chunk: ProtomuxMessage<Chunk>;
    end: ProtomuxMessage<End>;
  };
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private isClosed = false;
  private readonly attachedAt = Date.now();
  private openedAt: number | null = null;
  private made = 0;
  private served = 0;

  /** Null when the stream already has this channel or is gone. */
  static attach(
    connection: SecretStream,
    device: string,
    gateway: InferenceGateway,
    onClose?: () => void,
    diag?: LinkDiag
  ): InferenceLink | null {
    const channel = Protomux.from(connection).createChannel({
      protocol: INFERENCE_PROTOCOL,
      onopen: () => link.onOpened(),
      onclose: (isRemote) => link.onClosed(isRemote),
    });
    if (!channel) {
      diag?.('link.attach-skipped', { device: device.slice(0, 8) });
      return null;
    }
    const link: InferenceLink = new InferenceLink(channel, device, gateway, onClose, diag);
    channel.open();
    return link;
  }

  private constructor(
    channel: ProtomuxChannel,
    private readonly device: string,
    private readonly gateway: InferenceGateway,
    private readonly onClose?: () => void,
    private readonly diag?: LinkDiag
  ) {
    this.channel = channel;
    // The order of addMessage calls is the wire format; both sides must match.
    this.send = {
      request: channel.addMessage({ encoding: json, onmessage: (value) => this.onRequest(value) }) as ProtomuxMessage<GatewayRequest>,
      cancel: channel.addMessage({ encoding: json, onmessage: (value) => this.onCancel(value) }) as ProtomuxMessage<{ id: number }>,
      head: channel.addMessage({ encoding: json, onmessage: (value) => this.onHead(value as Head) }) as ProtomuxMessage<Head>,
      chunk: channel.addMessage({ encoding: chunkEncoding, onmessage: (value) => this.onChunk(value) }),
      end: channel.addMessage({ encoding: json, onmessage: (value) => this.onEnd(value as End) }) as ProtomuxMessage<End>,
    };
  }

  // ---- Consumer side -------------------------------------------------------------------------

  /** Ask the other side's gateway. Resolves at the reply's head; `signal` cancels it there too. */
  async request(request: SharedModelRequest, signal?: AbortSignal): Promise<SharedModelResponse> {
    const waitStarted = Date.now();
    if (!(await this.channel.fullyOpened())) {
      this.diag?.('link.request-not-open', { device: this.device.slice(0, 8), waitedMs: Date.now() - waitStarted });
      throw new Error('The provider is not connected.');
    }
    if (signal?.aborted) throw new Error('cancelled');
    const id = this.nextId++;
    this.made++;
    this.diag?.('shared.request', {
      device: this.device.slice(0, 8),
      id,
      circle: request.circle.slice(0, 8),
      method: request.method,
      path: request.path,
      bodyBytes: Buffer.byteLength(request.body ?? ''),
      openWaitMs: Date.now() - waitStarted,
      inFlight: this.pending.size,
    });
    return new Promise<SharedModelResponse>((resolve, reject) => {
      const entry: Pending = { head: resolve, fail: reject, body: null, sentAt: Date.now(), bytes: 0, chunks: 0, firstChunkMs: null };
      this.pending.set(id, entry);
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.send.cancel.send({ id });
          this.diag?.('shared.cancel', {
            device: this.device.slice(0, 8),
            id,
            afterHead: entry.body !== null,
            bytes: entry.bytes,
            ms: Date.now() - entry.sentAt,
          });
          const error = new Error('cancelled');
          if (entry.body) entry.body.destroy(error);
          else reject(error);
        },
        { once: true }
      );
      this.send.request.send({ ...request, id });
    });
  }

  private onHead(head: Head): void {
    const entry = isId(head?.id) ? this.pending.get(head.id) : undefined;
    if (!entry || entry.body) return;
    // Reads don't pull from the provider; Protomux has no per-channel flow control.
    entry.body = new Readable({ read: () => undefined });
    this.diag?.('shared.head', {
      device: this.device.slice(0, 8),
      id: head.id,
      status: head.status,
      contentType: head.contentType,
      headMs: Date.now() - entry.sentAt,
    });
    entry.head({
      status: Number.isInteger(head.status) ? head.status : 502,
      contentType: isString(head.contentType) ? head.contentType : 'application/octet-stream',
      body: entry.body,
    });
  }

  private onChunk(chunk: Chunk): void {
    const entry = this.pending.get(chunk.id);
    if (!entry?.body) return;
    entry.firstChunkMs ??= Date.now() - entry.sentAt;
    entry.bytes += chunk.data.length;
    entry.chunks++;
    entry.body.push(chunk.data);
  }

  private onEnd(end: End): void {
    const entry = isId(end?.id) ? this.pending.get(end.id) : undefined;
    if (!entry) return;
    this.pending.delete(end.id);
    const error = isString(end.error) ? new Error(end.error) : null;
    this.diag?.('shared.end', {
      device: this.device.slice(0, 8),
      id: end.id,
      gotHead: entry.body !== null,
      error: error?.message ?? null,
      bytes: entry.bytes,
      chunks: entry.chunks,
      firstChunkMs: entry.firstChunkMs,
      ms: Date.now() - entry.sentAt,
    });
    if (!entry.body) entry.fail(error ?? new Error('The provider ended the request without an answer.'));
    else if (error) entry.body.destroy(error);
    else entry.body.push(null);
  }

  // ---- Provider side -------------------------------------------------------------------------

  private onRequest(value: unknown): void {
    const request = asRequest(value);
    if (!request) {
      this.diag?.('link.bad-request', { device: this.device.slice(0, 8) });
      return;
    }
    this.served++;
    const { id } = request;
    this.gateway.handle(this.device, request, {
      head: (status, contentType) => this.send.head.send({ id, status, contentType }),
      chunk: (data) => this.send.chunk.send({ id, data }),
      end: (error) => this.send.end.send(error ? { id, error } : { id }),
    });
  }

  private onCancel(value: unknown): void {
    const id = (value as { id?: unknown })?.id;
    if (isId(id)) this.gateway.cancel(this.device, id);
  }

  // ---- Both ----------------------------------------------------------------------------------

  get closed(): boolean {
    return this.isClosed;
  }

  close(): void {
    this.channel.close();
  }

  private onOpened(): void {
    this.openedAt = Date.now();
    this.diag?.('link.open', { device: this.device.slice(0, 8), afterMs: this.openedAt - this.attachedAt });
  }

  private onClosed(isRemote: boolean): void {
    this.isClosed = true;
    this.diag?.('link.close', {
      device: this.device.slice(0, 8),
      isRemote,
      everOpened: this.openedAt !== null,
      openMs: this.openedAt === null ? null : Date.now() - this.openedAt,
      made: this.made,
      served: this.served,
      pending: this.pending.size,
    });
    this.gateway.dropPeer(this.device);
    const error = new Error('The provider disconnected.');
    for (const entry of this.pending.values()) {
      if (entry.body) entry.body.destroy(error);
      else entry.fail(error);
    }
    this.pending.clear();
    this.onClose?.();
  }
}
