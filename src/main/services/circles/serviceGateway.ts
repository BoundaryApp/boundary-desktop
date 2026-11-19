/**
 * The provider's side of a shared service (ADR 0048 §3–4): a member's tool call arrives over the
 * service channel and is forwarded to the provider's own instance with that member's key. Only
 * `POST /mcp` passes, only from a current member's device, and only at a level the provider
 * granted that member. Requests are forwarded as they arrive, up to `SERVICE_MEMBER_CONCURRENCY`
 * at a time per member, and counted per member per day.
 *
 * Kept free of native modules so it can be tested on its own. Logs carry metadata only: who, which
 * service, the JSON-RPC method and tool name, status and timings, never arguments or results (§13).
 */
import { addUsage, localDay } from '../../../shared/circleUsage';
import type { CircleDayUsage } from '../../../shared/types/circles';
import type { ShareLevel } from '../../../shared/serviceOffers';
import { errorName, pipeBody, refuse, type GatewaySink, type MemberGatewayDeps } from './inferenceGateway';

/** What a member's device asks for. `id` is unique per connection and direction. */
export interface ServiceRequest {
  id: number;
  /** The Circle's key (hex) the member reached this provider through. */
  circle: string;
  /** The offer's key in the provider's `services` record. */
  service: string;
  /** The level the member's agent is using: its read token or its write token. */
  level: ShareLevel;
  method: string;
  path: string;
  /** The MCP client's `Accept`, passed on so Twenty answers with JSON or an event stream. */
  accept?: string;
  /** JSON text. */
  body?: string;
}

/** What the provider has offered in a Circle, as far as the gateway needs it. */
export interface ServiceOffer {
  available: boolean;
}

/** One member's keys for one service. `write` is present only for a write grant. */
export interface ServiceGrantKeys {
  read: string;
  write?: string;
}

export interface ServiceUpstream {
  /** The instance's MCP endpoint as this Mac reaches it, such as `http://127.0.0.1:3000/mcp`. */
  mcpUrl: string;
}

export interface ServiceGatewayDeps extends MemberGatewayDeps {
  /** This user's offer of `service` in `circle`, or null when they don't share it there. */
  offerFor(circle: string, service: string): ServiceOffer | null;
  /** The keys the provider granted `identity` for `service` in `circle`, or null. */
  grantFor(circle: string, service: string, identity: string): ServiceGrantKeys | null;
  upstream(service: string): ServiceUpstream | null;
  onUsage?(served: CircleDayUsage): void;
}

/** Twenty's tool calls are small; anything larger is refused before it's forwarded (spec decision 5). */
export const SERVICE_MAX_BODY_BYTES = 1024 * 1024;
/** Calls one member may have running at once (spec decision 4). */
export const SERVICE_MEMBER_CONCURRENCY = 4;
const DEFAULT_ACCEPT = 'application/json, text/event-stream';

/**
 * The upstream URL for a request's path. Hermes registers Twenty as `<url>/mcp?mode=meta`, which
 * from Twenty 2.56 lists the catalog tools instead of every record tool, so `mode=meta` passes
 * on. Any other query is dropped.
 */
function serviceUpstreamUrl(mcpUrl: string, path: string): string {
  const query = path.includes('?') ? new URLSearchParams(path.slice(path.indexOf('?') + 1)) : null;
  return query?.get('mode') === 'meta' ? `${mcpUrl}?mode=meta` : mcpUrl;
}

interface Call {
  device: string;
  id: number;
  identity: string;
  abort: AbortController;
}

/** The JSON-RPC method and, for `tools/call`, the tool's name. Never arguments. */
function rpcShape(body: unknown): { rpc: string | null; tool: string | null; batch: number | null } {
  if (Array.isArray(body)) return { rpc: null, tool: null, batch: body.length };
  const message = body as { method?: unknown; params?: { name?: unknown } };
  const rpc = typeof message.method === 'string' ? message.method.slice(0, 64) : null;
  const tool = rpc === 'tools/call' && typeof message.params?.name === 'string' ? message.params.name.slice(0, 64) : null;
  return { rpc, tool, batch: null };
}

export class ServiceGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly calls = new Set<Call>();
  private closed = false;
  private served: CircleDayUsage | undefined;

  constructor(private readonly deps: ServiceGatewayDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.served = deps.usage;
  }

  /** Answer one request from `device`. Never throws; every outcome reaches `sink`. */
  handle(device: string, request: ServiceRequest, sink: GatewaySink): void {
    const at = { device: device.slice(0, 8), circle: request.circle.slice(0, 8), service: request.service, id: request.id };
    const refuseWith = (status: number, message: string, reason: string): void => {
      this.deps.diag?.('service.refused', { ...at, status, reason });
      refuse(sink, status, message);
    };

    if (this.closed) return refuseWith(503, 'This person has stopped sharing.', 'closed');
    if (request.method !== 'POST' || request.path.split('?')[0].replace(/\/+$/, '') !== '/mcp') {
      return refuseWith(404, 'Not found.', 'path');
    }
    const identity = this.deps.memberFor(request.circle, device);
    if (!identity) return refuseWith(403, 'Not a member of that Circle.', 'not-member');
    const offer = this.deps.offerFor(request.circle, request.service);
    if (!offer || !offer.available) return refuseWith(503, 'This person isn’t sharing that now.', offer ? 'paused' : 'no-offer');
    const grant = this.deps.grantFor(request.circle, request.service, identity);
    if (!grant) return refuseWith(403, 'You haven’t been given access to this.', 'no-grant');
    const key = request.level === 'write' ? grant.write : grant.read;
    if (!key) return refuseWith(403, 'You can look things up here but not make changes.', 'read-only');
    const upstream = this.deps.upstream(request.service);
    if (!upstream) return refuseWith(503, 'This person’s service isn’t running.', 'no-upstream');

    const bodyBytes = Buffer.byteLength(request.body ?? '');
    if (bodyBytes > SERVICE_MAX_BODY_BYTES) return refuseWith(413, 'Request body is too large.', 'too-large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body ?? '');
    } catch {
      return refuseWith(400, 'Request body is not JSON.', 'not-json');
    }
    if (typeof parsed !== 'object' || parsed === null) return refuseWith(400, 'Request body is not a JSON object.', 'not-object');

    const running = [...this.calls].filter((call) => call.identity === identity).length;
    if (running >= SERVICE_MEMBER_CONCURRENCY) {
      return refuseWith(429, 'You have as many calls running here as this person allows.', 'busy');
    }

    const call: Call = { device, id: request.id, identity, abort: new AbortController() };
    this.calls.add(call);
    this.served = addUsage(this.served, identity, localDay(new Date()), { requests: 1 });
    this.deps.onUsage?.(this.served);
    void this.forward(call, request, upstream, key, rpcShape(parsed), bodyBytes, sink).finally(() => {
      this.calls.delete(call);
    });
  }

  /** The member gave up on a request. */
  cancel(device: string, id: number): void {
    for (const call of this.calls) if (call.device === device && call.id === id) call.abort.abort();
  }

  /** The device disconnected. */
  dropPeer(device: string): void {
    for (const call of this.calls) if (call.device === device) call.abort.abort();
  }

  /** For the periodic health record. */
  stats(): { running: number } {
    return { running: this.calls.size };
  }

  /** Refuse what comes next and stop what is running. */
  close(): void {
    this.closed = true;
    for (const call of this.calls) call.abort.abort();
  }

  private async forward(
    call: Call,
    request: ServiceRequest,
    upstream: ServiceUpstream,
    key: string,
    shape: ReturnType<typeof rpcShape>,
    bodyBytes: number,
    sink: GatewaySink
  ): Promise<void> {
    const started = Date.now();
    const meta = { member: call.identity.slice(0, 12), service: request.service, level: request.level, ...shape };
    let headSent = false;
    let bytes = 0;
    try {
      const response = await this.fetchImpl(serviceUpstreamUrl(upstream.mcpUrl, request.path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: request.accept || DEFAULT_ACCEPT,
          Authorization: `Bearer ${key}`,
        },
        body: request.body,
        signal: call.abort.signal,
        // A redirect would carry the member's key on to wherever it points.
        redirect: 'error',
      });
      sink.head(response.status, response.headers.get('content-type') ?? 'application/json');
      headSent = true;
      await pipeBody(response, sink, (data) => {
        bytes += data.length;
      });
      sink.end();
      this.deps.log?.('shared service request', { ...meta, status: response.status, bodyBytes, bytes, ms: Date.now() - started });
    } catch (err) {
      const cancelled = call.abort.signal.aborted;
      if (headSent) sink.end(cancelled ? 'cancelled' : 'The service stopped mid-reply.');
      else if (!cancelled) refuse(sink, 502, 'This person’s service isn’t reachable.');
      else refuse(sink, 503, 'This person has stopped sharing.');
      this.deps.log?.('shared service request failed', {
        ...meta,
        cancelled,
        afterHead: headSent,
        error: errorName(err),
        ms: Date.now() - started,
      });
    }
  }
}
