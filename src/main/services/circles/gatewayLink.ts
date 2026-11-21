/**
 * A request-and-reply channel between two members' devices, carrying calls to the other side's
 * gateway: one Protomux channel per connection, sharing the muxer Corestore replicates over.
 * Either side can ask the other's gateway and serve requests to its own. The `inference` channel
 * (ADR 0034 §2) and the `service` channel (ADR 0048 §1) are two of these, each with its own
 * protocol name and request shape.
 *
 * Every message goes over the encrypted stream, so it arrives once and in order. Secret-stream's
 * unordered `send`/`trySend` are never used: they can lose, repeat and reorder messages.
 */
import { Readable } from 'node:stream';
import { buffer, json, uint, type Encoding, type State } from 'compact-encoding';
import Protomux, { type ProtomuxChannel, type ProtomuxMessage } from 'protomux';
import type { SecretStream } from 'hyperswarm';
import type { GatewaySink } from './gatewayCommon';

/** What a consumer gets back: the provider's status and a stream of its reply bytes. */
export interface LinkResponse {
  status: number;
  contentType: string;
  body: Readable;
}

/** The provider's side, which answers the other device's requests. */
export interface LinkGateway<R> {
  handle(device: string, request: R, sink: GatewaySink): void;
  cancel(device: string, id: number): void;
  dropPeer(device: string): void;
}

/** What makes one kind of link: both sides must use the same spec. */
export interface LinkSpec<R extends { id: number }> {
  protocol: string;
  /** Checks a request from the other side, which is a member's device but still checked. */
  parse(value: unknown): R | null;
  /** Diagnostics event prefixes: `<link>.open`, `<link>.close`, `<call>.request`, `<call>.end`. */
  events: { link: string; call: string };
  /** Metadata about an outgoing request, for diagnostics. Never a body. */
  describe(request: Omit<R, 'id'>): Record<string, unknown>;
}

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

export const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const isString = (value: unknown): value is string => typeof value === 'string';

interface Pending {
  head: (response: LinkResponse) => void;
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
export function onLinkOpen(connection: SecretStream, protocol: string, onOpen: () => void): void {
  Protomux.from(connection).pair({ protocol }, onOpen);
}

export class GatewayLink<R extends { id: number }> {
  private readonly channel: ProtomuxChannel;
  private readonly send: {
    request: ProtomuxMessage<R>;
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
  static attach<R extends { id: number }>(
    spec: LinkSpec<R>,
    connection: SecretStream,
    device: string,
    gateway: LinkGateway<R>,
    onClose?: () => void,
    diag?: LinkDiag
  ): GatewayLink<R> | null {
    const channel = Protomux.from(connection).createChannel({
      protocol: spec.protocol,
      onopen: () => link.onOpened(),
      onclose: (isRemote) => link.onClosed(isRemote),
    });
    if (!channel) {
      diag?.(`${spec.events.link}.attach-skipped`, { device: device.slice(0, 8) });
      return null;
    }
    const link: GatewayLink<R> = new GatewayLink(spec, channel, device, gateway, onClose, diag);
    channel.open();
    return link;
  }

  private constructor(
    private readonly spec: LinkSpec<R>,
    channel: ProtomuxChannel,
    private readonly device: string,
    private readonly gateway: LinkGateway<R>,
    private readonly onClose?: () => void,
    private readonly diag?: LinkDiag
  ) {
    this.channel = channel;
    // The order of addMessage calls is the wire format; both sides must match.
    this.send = {
      request: channel.addMessage({ encoding: json, onmessage: (value) => this.onRequest(value) }) as ProtomuxMessage<R>,
      cancel: channel.addMessage({ encoding: json, onmessage: (value) => this.onCancel(value) }) as ProtomuxMessage<{ id: number }>,
      head: channel.addMessage({ encoding: json, onmessage: (value) => this.onHead(value as Head) }) as ProtomuxMessage<Head>,
      chunk: channel.addMessage({ encoding: chunkEncoding, onmessage: (value) => this.onChunk(value) }),
      end: channel.addMessage({ encoding: json, onmessage: (value) => this.onEnd(value as End) }) as ProtomuxMessage<End>,
    };
  }

  // ---- Consumer side -------------------------------------------------------------------------

  /** Ask the other side's gateway. Resolves at the reply's head; `signal` cancels it there too. */
  async request(request: Omit<R, 'id'>, signal?: AbortSignal): Promise<LinkResponse> {
    const waitStarted = Date.now();
    const { link: linkEvent, call } = this.spec.events;
    if (!(await this.channel.fullyOpened())) {
      this.diag?.(`${linkEvent}.request-not-open`, { device: this.device.slice(0, 8), waitedMs: Date.now() - waitStarted });
      throw new Error('The provider is not connected.');
    }
    if (signal?.aborted) throw new Error('cancelled');
    const id = this.nextId++;
    this.made++;
    this.diag?.(`${call}.request`, {
      device: this.device.slice(0, 8),
      id,
      ...this.spec.describe(request),
      openWaitMs: Date.now() - waitStarted,
      inFlight: this.pending.size,
    });
    return new Promise<LinkResponse>((resolve, reject) => {
      const entry: Pending = { head: resolve, fail: reject, body: null, sentAt: Date.now(), bytes: 0, chunks: 0, firstChunkMs: null };
      this.pending.set(id, entry);
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.send.cancel.send({ id });
          this.diag?.(`${call}.cancel`, {
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
      this.send.request.send({ ...request, id } as R);
    });
  }

  private onHead(head: Head): void {
    const entry = isId(head?.id) ? this.pending.get(head.id) : undefined;
    if (!entry || entry.body) return;
    // Reads don't pull from the provider; Protomux has no per-channel flow control.
    entry.body = new Readable({ read: () => undefined });
    this.diag?.(`${this.spec.events.call}.head`, {
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
    this.diag?.(`${this.spec.events.call}.end`, {
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
    const request = this.spec.parse(value);
    if (!request) {
      this.diag?.(`${this.spec.events.link}.bad-request`, { device: this.device.slice(0, 8) });
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
    this.diag?.(`${this.spec.events.link}.open`, { device: this.device.slice(0, 8), afterMs: this.openedAt - this.attachedAt });
  }

  private onClosed(isRemote: boolean): void {
    this.isClosed = true;
    this.diag?.(`${this.spec.events.link}.close`, {
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
