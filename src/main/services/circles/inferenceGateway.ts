/**
 * The provider's side of a shared model (ADR 0034 §2): requests from Circle members arrive over
 * the inference channel and are forwarded to the provider's own model server. Only
 * `GET /v1/models` and `POST /v1/chat/completions` pass, only from current members' devices, and
 * only for models in this user's offer to that Circle. Chat requests run one at a time, in the
 * order they arrived. Requests and tokens are counted per member, and a member over a limit is
 * answered 429 before any reply starts (§5).
 *
 * Kept free of native modules so it can be tested on its own. Logs carry metadata only: who,
 * which model, status and timings, never prompt or reply text (§6).
 */
import { addUsage, limitFor, localDay, usedToday } from '../../../shared/circleUsage';
import type { CircleDayUsage, CircleLimit, CircleLimits, CircleServing, CircleUsageCount } from '../../../shared/types/circles';
import type { CircleOffer } from './circleOps';
import { UsageTail } from './usageTail';

/** What a consumer asks for. `id` is unique per connection and direction. */
export interface GatewayRequest {
  id: number;
  /** The Circle's key (hex) the consumer reached this provider through. */
  circle: string;
  method: string;
  path: string;
  /** JSON text. */
  body?: string;
}

/** Where a request's answer goes: one head, any number of chunks, then one end. */
export interface GatewaySink {
  head(status: number, contentType: string): void;
  chunk(data: Buffer): void;
  /** `error` when the reply stopped after its head. */
  end(error?: string): void;
}

/** The provider's model server, as seen from this Mac. */
export interface GatewayUpstream {
  /** OpenAI-compatible base URL, ending before `/models` and `/chat/completions`. */
  baseUrl: string;
  apiKey?: string;
}

export interface InferenceGatewayDeps {
  /** This user's offer in a Circle, or null when they share nothing there. */
  offerFor(circle: string): CircleOffer | null;
  /** The identity of the current member using `device` in `circle`, or null. */
  memberFor(circle: string, device: string): string | null;
  upstream(): GatewayUpstream | null;
  fetchImpl?: typeof fetch;
  log?(message: string, data?: Record<string, unknown>): void;
  /** Diagnostics events (metadata only): every request's path through the gateway. */
  diag?(event: string, data: Record<string, unknown>): void;
  /** What today's counts started from, kept by main across restarts. */
  usage?: CircleDayUsage;
  /** Counts or the queue changed. */
  onUsage?(served: CircleDayUsage | undefined, serving: CircleServing): void;
}

/** Larger than any chat request Boundary sends, and well under secret-stream's 16 MB frame. */
export const GATEWAY_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Reply bytes go out in pieces no larger than this, so one big read can't hog the stream. */
export const GATEWAY_CHUNK_BYTES = 64 * 1024;

interface Job {
  device: string;
  request: GatewayRequest;
  identity: string;
  model: string;
  sink: GatewaySink;
  abort: AbortController;
  queuedAt: number;
}

/** An error's class and code, never its message, which for fetch can echo a URL. */
function errorName(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  return [err.name, cause?.code].filter(Boolean).join(':');
}

/** Why `limit` stops a member from starting another request, or null. */
function overLimit(limit: CircleLimit, used: CircleUsageCount, active: number): string | null {
  if (limit.concurrent !== undefined && active >= limit.concurrent) return 'You have as many requests running here as this provider allows.';
  if (limit.requestsPerDay !== undefined && used.requests >= limit.requestsPerDay) return 'You’ve used today’s requests from this provider.';
  if (limit.tokensPerDay !== undefined && used.tokens >= limit.tokensPerDay) return 'You’ve used today’s tokens from this provider.';
  return null;
}

function normalizePath(path: string): string {
  return path.split('?')[0].replace(/\/+$/, '');
}

function errorBody(message: string): Buffer {
  return Buffer.from(JSON.stringify({ error: { message, type: 'boundary_gateway_error' } }));
}

function refuse(sink: GatewaySink, status: number, message: string): void {
  sink.head(status, 'application/json');
  sink.chunk(errorBody(message));
  sink.end();
}

function upstreamUrl(upstream: GatewayUpstream, path: string): string {
  return `${upstream.baseUrl.replace(/\/+$/, '')}${path}`;
}

function upstreamHeaders(upstream: GatewayUpstream): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
  };
}

export class InferenceGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private closed = false;
  private limits: CircleLimits | null = null;
  private served: CircleDayUsage | undefined;

  constructor(private readonly deps: InferenceGatewayDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.served = deps.usage;
  }

  /** Applies to requests from now on; ones already waiting stay. */
  setLimits(limits: CircleLimits | null): void {
    this.limits = limits;
  }

  private count(identity: string, added: Partial<CircleUsageCount>): void {
    this.served = addUsage(this.served, identity, localDay(new Date()), added);
  }

  private report(): void {
    this.deps.onUsage?.(this.served, {
      running: this.running?.identity ?? null,
      queued: this.queue.map((job) => job.identity),
    });
  }

  /** Answer one request from `device`. Never throws; every outcome reaches `sink`. */
  handle(device: string, request: GatewayRequest, sink: GatewaySink): void {
    const at = { device: device.slice(0, 8), circle: request.circle.slice(0, 8), id: request.id };
    this.deps.diag?.('gateway.request', {
      ...at,
      method: request.method,
      path: request.path,
      bodyBytes: Buffer.byteLength(request.body ?? ''),
      queued: this.queue.length,
      running: this.running !== null,
    });
    const refuseWith = (status: number, message: string, reason: string): void => {
      this.deps.diag?.('gateway.refused', { ...at, status, reason });
      refuse(sink, status, message);
    };
    this.handleChecked(device, request, sink, refuseWith);
  }

  private handleChecked(
    device: string,
    request: GatewayRequest,
    sink: GatewaySink,
    refuse: (status: number, message: string, reason: string) => void
  ): void {
    if (this.closed) return refuse(503, 'This provider has stopped sharing.', 'closed');
    const path = normalizePath(request.path);
    const isModels = request.method === 'GET' && path === '/v1/models';
    const isChat = request.method === 'POST' && path === '/v1/chat/completions';
    if (!isModels && !isChat) return refuse(404, 'Not found.', 'path');

    const identity = this.deps.memberFor(request.circle, device);
    if (!identity) return refuse(403, 'Not a member of that Circle.', 'not-member');
    const offer = this.deps.offerFor(request.circle);
    if (!offer) return refuse(503, 'This provider isn’t sharing a model now.', 'no-offer');
    if (!offer.available) return refuse(503, 'This provider isn’t sharing a model now.', 'paused');
    const upstream = this.deps.upstream();
    if (!upstream) return refuse(503, 'This provider’s model server isn’t set up.', 'no-upstream');

    if (isModels) {
      void this.models(upstream, offer, sink);
      return;
    }
    if (Buffer.byteLength(request.body ?? '') > GATEWAY_MAX_BODY_BYTES) {
      return refuse(413, 'Request body is too large.', 'too-large');
    }
    let body: { model?: unknown; stream?: unknown; messages?: unknown; tools?: unknown };
    try {
      body = JSON.parse(request.body ?? '') as typeof body;
    } catch {
      return refuse(400, 'Request body is not JSON.', 'not-json');
    }
    if (typeof body !== 'object' || body === null) return refuse(400, 'Request body is not a JSON object.', 'not-object');
    const model = typeof body.model === 'string' ? body.model : '';
    if (!offer.models.some((offered) => offered.id === model)) {
      return refuse(404, 'That model isn’t shared.', 'model-not-offered');
    }
    const active = this.queue.filter((job) => job.identity === identity).length + (this.running?.identity === identity ? 1 : 0);
    const over = overLimit(limitFor(this.limits, identity), usedToday(this.served, identity, localDay(new Date())), active);
    if (over) return refuse(429, over, 'over-limit');
    // Shape only: counts, never content.
    this.deps.diag?.('gateway.queued', {
      device: device.slice(0, 8),
      id: request.id,
      member: identity.slice(0, 8),
      model,
      stream: body.stream === true,
      messages: Array.isArray(body.messages) ? body.messages.length : null,
      tools: Array.isArray(body.tools) ? body.tools.length : null,
      ahead: this.queue.length + (this.running ? 1 : 0),
    });
    this.queue.push({ device, request, identity, model, sink, abort: new AbortController(), queuedAt: Date.now() });
    // Counted on arrival, so requests waiting in the queue can't pass the limit together.
    this.count(identity, { requests: 1 });
    this.pump();
    this.report();
  }

  /** The consumer gave up on a request: drop it from the queue or stop it. */
  cancel(device: string, id: number): void {
    this.deps.diag?.('gateway.cancel', { device: device.slice(0, 8), id });
    this.dropWhere((job) => job.device === device && job.request.id === id);
  }

  /** The device disconnected. */
  dropPeer(device: string): void {
    const queued = this.queue.filter((job) => job.device === device).length;
    const running = this.running?.device === device;
    if (queued || running) this.deps.diag?.('gateway.drop-peer', { device: device.slice(0, 8), queued, running });
    this.dropWhere((job) => job.device === device);
  }

  /** For the periodic health record. */
  stats(): { queued: number; running: boolean } {
    return { queued: this.queue.length, running: this.running !== null };
  }

  /** Refuse whatever is waiting and stop what is running. */
  close(): void {
    this.closed = true;
    this.dropWhere(() => true, 'This provider has stopped sharing.');
  }

  private dropWhere(test: (job: Job) => boolean, reason?: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (!test(job)) continue;
      this.queue.splice(i, 1);
      this.count(job.identity, { requests: -1 });
      if (reason) refuse(job.sink, 503, reason);
    }
    if (this.running && test(this.running)) this.running.abort.abort();
    this.report();
  }

  private pump(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    void this.chat(job).finally(() => {
      this.running = null;
      this.pump();
      this.report();
    });
  }

  private async models(upstream: GatewayUpstream, offer: CircleOffer, sink: GatewaySink): Promise<void> {
    // The server's own list, cut to the offer, so a model that isn't loaded doesn't show.
    const started = Date.now();
    try {
      const response = await this.fetchImpl(upstreamUrl(upstream, '/models'), { headers: upstreamHeaders(upstream) });
      if (!response.ok) {
        this.deps.diag?.('gateway.models', { upstreamStatus: response.status, ms: Date.now() - started });
        return refuse(sink, 502, `The model server answered ${response.status}.`);
      }
      const listed = (await response.json()) as { data?: Array<{ id?: unknown }> };
      const offered = new Map(offer.models.map((model) => [model.id, model]));
      const data = (Array.isArray(listed.data) ? listed.data : [])
        .filter((model) => typeof model.id === 'string' && offered.has(model.id))
        .map((model) => {
          const shared = offered.get(model.id as string)!;
          return {
            id: shared.id,
            object: 'model',
            owned_by: 'circle',
            ...(shared.contextLength ? { context_length: shared.contextLength } : {}),
          };
        });
      this.deps.diag?.('gateway.models', {
        upstreamStatus: response.status,
        listed: Array.isArray(listed.data) ? listed.data.length : null,
        offered: offer.models.length,
        served: data.length,
        ms: Date.now() - started,
      });
      sink.head(200, 'application/json');
      sink.chunk(Buffer.from(JSON.stringify({ object: 'list', data })));
      sink.end();
    } catch (err) {
      this.deps.diag?.('gateway.models', { error: errorName(err), ms: Date.now() - started });
      refuse(sink, 502, 'The model server isn’t reachable.');
    }
  }

  private async chat(job: Job): Promise<void> {
    const { sink } = job;
    const upstream = this.deps.upstream();
    const started = Date.now();
    const meta = { member: job.identity.slice(0, 12), model: job.model, queuedMs: started - job.queuedAt };
    if (!upstream) {
      this.count(job.identity, { requests: -1 });
      refuse(sink, 503, 'This provider’s model server isn’t set up.');
      return;
    }
    if (job.abort.signal.aborted) {
      this.count(job.identity, { requests: -1 });
      return;
    }
    this.deps.diag?.('gateway.start', { device: job.device.slice(0, 8), id: job.request.id, waitMs: meta.queuedMs });
    let headSent = false;
    let bytes = 0;
    let chunks = 0;
    let firstChunkMs: number | null = null;
    const tail = new UsageTail();
    try {
      const response = await this.fetchImpl(upstreamUrl(upstream, '/chat/completions'), {
        method: 'POST',
        headers: upstreamHeaders(upstream),
        body: job.request.body,
        signal: job.abort.signal,
      });
      const headMs = Date.now() - started;
      this.deps.diag?.('gateway.upstream-head', {
        device: job.device.slice(0, 8),
        id: job.request.id,
        status: response.status,
        contentType: response.headers.get('content-type'),
        headMs,
      });
      // A refused request served nothing, so it doesn't use up the member's day.
      if (!response.ok) this.count(job.identity, { requests: -1 });
      sink.head(response.status, response.headers.get('content-type') ?? 'application/json');
      headSent = true;
      if (response.body) {
        for await (const piece of response.body as AsyncIterable<Uint8Array>) {
          const data = Buffer.from(piece);
          firstChunkMs ??= Date.now() - started;
          bytes += data.length;
          tail.push(data);
          for (let at = 0; at < data.length; at += GATEWAY_CHUNK_BYTES) {
            chunks++;
            sink.chunk(data.subarray(at, at + GATEWAY_CHUNK_BYTES));
          }
        }
      }
      sink.end();
      const tokens = response.ok ? tail.tokens() : null;
      if (tokens) this.count(job.identity, { tokens });
      this.deps.log?.('shared model request', { ...meta, status: response.status, tokens, ms: Date.now() - started });
      this.deps.diag?.('gateway.done', {
        device: job.device.slice(0, 8),
        id: job.request.id,
        status: response.status,
        bytes,
        chunks,
        headMs,
        firstChunkMs,
        tokens,
        ms: Date.now() - started,
      });
    } catch (err) {
      const cancelled = job.abort.signal.aborted;
      if (!headSent) this.count(job.identity, { requests: -1 });
      if (headSent) sink.end(cancelled ? 'cancelled' : 'The model server stopped mid-reply.');
      else if (!cancelled) refuse(sink, 502, 'The model server isn’t reachable.');
      this.deps.log?.('shared model request failed', {
        ...meta,
        cancelled,
        afterHead: headSent,
        ms: Date.now() - started,
      });
      this.deps.diag?.('gateway.failed', {
        device: job.device.slice(0, 8),
        id: job.request.id,
        cancelled,
        afterHead: headSent,
        error: errorName(err),
        bytes,
        chunks,
        ms: Date.now() - started,
      });
    }
  }
}
