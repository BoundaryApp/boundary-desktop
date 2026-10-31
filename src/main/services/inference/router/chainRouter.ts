import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { InferenceChainEntryState, PeerModelRef } from '../../../../shared/types/inferenceChain';
import { checkBridgeRequest, readLimitedBody } from '../../hostBridge/requestGuard';
import {
  opensNewTurn,
  planChainAttempts,
  runChainAttempts,
  shouldFallBack,
  type ChainAttemptOutcome,
  type ChainAttemptRecord,
} from '../chain/chainAttempts';
import { APP_NAME } from '../../../../shared/buildIdentity';

/**
 * The inference router (ADR 0033 §5–8). llm-proxy's chat and LightRAG routes point here when a
 * chain has more than one entry; the router walks the chain and streams the first answer back.
 *
 * Plain Node, so tests drive it with real sockets. It listens on loopback only and passes the
 * host bridge's request checks (ADR 0027 §2): containers reach it through host.docker.internal
 * with the token llm-proxy sends as its upstream key.
 */

/** The header Hermes sends with its session affinity key (`providers.<name>.session_affinity_header`). */
export const ROUTER_SESSION_HEADER = 'x-boundary-session';
/** The entry that served, as `chainEntryKey`; feeds the chat's provenance line (ADR 0033 §3). */
export const ROUTER_SERVED_HEADER = 'x-boundary-served';

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const STICKY_LIMIT = 500;

/** Where one chain entry is served from. */
export interface RouterUpstream {
  /** OpenAI-compatible base URL as seen from the host, ending before `/chat/completions`. */
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  /** A member's shared model, reached through the Circles network instead of `baseUrl`. */
  peer?: PeerModelRef;
  /** What error text calls this entry; shared models' keys aren't for reading. */
  label?: string;
}

/** Calls a shared model's `/v1/chat/completions` with a JSON body; resolves at the reply's head. */
export type PeerFetch = (peer: PeerModelRef, body: string, signal: AbortSignal) => Promise<Response>;

export interface RouterChain {
  entries: InferenceChainEntryState[];
  /** By entry key. An entry without an upstream is skipped. */
  upstreams: Record<string, RouterUpstream>;
  /** The model name Hermes is configured with; `/v1/models` reports it. */
  modelId: string;
  /** The chain's smallest context, which Hermes is sized for (ADR 0033 §8). */
  contextLength?: number;
}

export interface RouterServed {
  sessionKey: string | null;
  entryKey: string;
  slot: InferenceChainEntryState['entry']['slot'];
  modelId: string;
  /** Who shares the model, when a shared model served. */
  peer?: InferenceChainEntryState['entry']['peer'];
  /** A later entry than the chain's first answered, now or earlier in the turn (ADR 0033 §3). */
  fellBack: boolean;
  at: number;
}

export interface ChainRouterOptions {
  token: string;
  getChain: () => RouterChain | null;
  /** How long to wait for an upstream's response headers before falling back. */
  headerTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Shared-model entries go here; without it they are unreachable. */
  peerFetch?: PeerFetch;
  onServed?: (served: RouterServed) => void;
  /** Metadata only: no prompt or reply text. */
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Diagnostics events (metadata only): each request's attempts, timings and reply size. */
  diag?: (event: string, data: Record<string, unknown>) => void;
}

/** Entry keys name a shared model's Circle and provider in full; diagnostics keep 8 characters. */
function shortKey(key: string): string {
  return key.startsWith('peer:') ? key.replace(/[0-9a-f]{64}/g, (hex) => hex.slice(0, 8)) : key;
}

export interface ChainRouter {
  port: number;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: { message, type: 'boundary_router_error' } });
}


/** About four bytes a token; only used to skip entries far too small for the request. */
function estimateTokens(body: Buffer): number {
  return Math.ceil(body.length / 4);
}

function describeOutcome(record: ChainAttemptRecord, chain: RouterChain): string {
  const { outcome } = record;
  const name = chain.upstreams[record.key]?.label ?? record.key;
  if (outcome.kind === 'status') return `${name}: HTTP ${outcome.status}`;
  if (outcome.kind === 'header-timeout') return `${name}: no answer in time`;
  return `${name}: unreachable`;
}

/** Sessions remember the entry that served them, oldest dropped first. */
class StickyEntries {
  private readonly map = new Map<string, string>();

  get(session: string | null): string | null {
    return session ? (this.map.get(session) ?? null) : null;
  }

  set(session: string | null, entryKey: string): void {
    if (!session) return;
    this.map.delete(session);
    this.map.set(session, entryKey);
    if (this.map.size > STICKY_LIMIT) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export async function startChainRouter(options: ChainRouterOptions): Promise<ChainRouter> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  const sticky = new StickyEntries();
  let port = 0;
  let nextRequest = 0;
  /** Requests at each entry now, by entry key, from the attempt until its reply ends. */
  const inFlight = new Map<string, number>();
  const holdEntry = (key: string): (() => void) => {
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (inFlight.get(key) ?? 1) - 1;
      if (left > 0) inFlight.set(key, left);
      else inFlight.delete(key);
    };
  };

  async function completions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chain = options.getChain();
    if (!chain) {
      sendError(res, 503, `${APP_NAME} has no inference chain to serve.`);
      return;
    }
    const raw = await readLimitedBody(req, MAX_BODY_BYTES);
    if (!raw) {
      sendError(res, 413, 'Request body is too large.');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      sendError(res, 400, 'Request body is not JSON.');
      return;
    }
    const receivedAt = Date.now();
    const inFlightAtStart = Object.fromEntries(
      [...inFlight].map(([key, count]) => [shortKey(key), count])
    );
    const sessionHeader = req.headers[ROUTER_SESSION_HEADER];
    const sessionKey = typeof sessionHeader === 'string' && sessionHeader ? sessionHeader : null;
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown }>) : [];
    const plan = planChainAttempts({
      entries: chain.entries.filter((state) => chain.upstreams[state.key]),
      stickyKey: sticky.get(sessionKey),
      newTurn: opensNewTurn(messages),
      // An estimate decides which entry to skip; with one entry the server decides.
      requestTokens: chain.entries.length > 1 ? estimateTokens(raw) : undefined,
    });

    const client = new AbortController();
    res.on('close', () => client.abort());
    // Set by each attempt; read after the chain run, so not narrowed here.
    let answer = null as Response | null;
    let releaseServed: () => void = () => undefined;

    const timings: Array<{ key: string; ms: number; outcome: string; status?: number }> = [];
    const timed = async (state: InferenceChainEntryState): Promise<ChainAttemptOutcome> => {
      const started = Date.now();
      const outcome = await attempt(state);
      timings.push({
        key: shortKey(state.key),
        ms: Date.now() - started,
        outcome: outcome.kind,
        ...(outcome.kind === 'status' ? { status: outcome.status } : {}),
      });
      return outcome;
    };
    const attempt = async (state: InferenceChainEntryState): Promise<ChainAttemptOutcome> => {
      const upstream = chain.upstreams[state.key];
      // The previous entry's refusal isn't read; free its socket.
      void answer?.body?.cancel().catch((): undefined => undefined);
      answer = null;
      const headerTimeout = new AbortController();
      // The last entry has nowhere to fall back to, so it may take as long as Hermes will wait:
      // a member's server can queue, or load a model, before its first byte.
      const timer = state.key === plan.at(-1)?.key ? undefined : setTimeout(() => headerTimeout.abort(), headerTimeoutMs);
      // The client hanging up also stops a reply that is already streaming.
      const signal = AbortSignal.any([client.signal, headerTimeout.signal]);
      const payload = JSON.stringify({ ...body, model: upstream.modelId });
      const release = holdEntry(state.key);
      try {
        let response: Response;
        if (upstream.peer) {
          if (!options.peerFetch) return { kind: 'unreachable' };
          response = await options.peerFetch(upstream.peer, payload, signal);
        } else {
          response = await fetchImpl(`${upstream.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
            },
            body: payload,
            signal,
          });
        }
        answer = response;
        if (response.ok) {
          releaseServed = release;
          return { kind: 'served' };
        }
        release();
        return { kind: 'status', status: response.status };
      } catch {
        release();
        // Nobody is waiting for an answer any more, so trying the next entry would be wasted.
        if (client.signal.aborted) return { kind: 'failed-mid-stream', detail: 'client closed' };
        if (headerTimeout.signal.aborted) return { kind: 'header-timeout' };
        return { kind: 'unreachable' };
      } finally {
        clearTimeout(timer);
      }
    };

    const result = await runChainAttempts(plan, timed);
    if (result.ok) {
      sticky.set(sessionKey, result.served.key);
      options.onServed?.({
        sessionKey,
        entryKey: result.served.key,
        slot: result.served.entry.slot,
        modelId: chain.upstreams[result.served.key].modelId,
        ...(result.served.entry.peer ? { peer: result.served.entry.peer } : {}),
        fellBack: result.served.key !== chain.entries[0]?.key,
        at: Date.now(),
      });
    }
    options.log?.('inference router request', {
      tried: result.tried.map((t) => ({ key: t.key, outcome: t.outcome.kind })),
      ok: result.ok,
    });
    const requestId = `${receivedAt.toString(36)}-${(nextRequest++).toString(36)}`;
    options.diag?.('router.request', {
      req: requestId,
      session: sessionKey ? sessionKey.slice(0, 8) : null,
      newTurn: opensNewTurn(messages),
      messages: messages.length,
      inFlight: inFlightAtStart,
      estTokens: estimateTokens(raw),
      stream: body.stream === true,
      tools: Array.isArray(body.tools) ? body.tools.length : null,
      chain: chain.entries.map((state) => ({
        key: shortKey(state.key),
        stale: state.stale,
        usable: Boolean(chain.upstreams[state.key]),
      })),
      sticky: sticky.get(sessionKey) ? shortKey(sticky.get(sessionKey)!) : null,
      attempts: timings,
      served: result.ok ? shortKey(result.served.key) : null,
      fellBack: result.ok ? result.served.key !== chain.entries[0]?.key : null,
      ms: Date.now() - receivedAt,
    });

    const last = result.tried.at(-1);
    // A refusal that doesn't allow fallback (400, 401…) is the upstream's answer; pass it on.
    const passThrough = !result.ok && last && last.outcome.kind === 'status' && !shouldFallBack(last.outcome)
      ? answer
      : null;
    const response: Response | null = result.ok ? answer : passThrough;
    if (!response) {
      const detail = result.tried.length
        ? result.tried.map((record) => describeOutcome(record, chain)).join('; ')
        : 'no usable entry';
      sendError(res, 503, `No model in the inference chain answered (${detail}).`);
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
    };
    if (result.ok) headers[ROUTER_SERVED_HEADER] = result.served.key;
    res.writeHead(response.status, headers);
    if (!response.body) {
      releaseServed();
      res.end();
      return;
    }
    // A failure once bytes have gone out ends the reply; it is never retried elsewhere (§6).
    let replyBytes = 0;
    let firstByteMs: number | null = null;
    const streamStarted = Date.now();
    const finish = (how: string): void => {
      options.diag?.('router.reply', {
        req: requestId,
        served: result.ok ? shortKey(result.served.key) : null,
        status: response.status,
        how,
        bytes: replyBytes,
        firstByteMs,
        ms: Date.now() - streamStarted,
      });
    };
    let finished = false;
    const finishOnce = (how: string): void => {
      if (finished) return;
      finished = true;
      releaseServed();
      finish(how);
    };
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      .on('data', (chunk: Buffer) => {
        firstByteMs ??= Date.now() - streamStarted;
        replyBytes += chunk.length;
      })
      .on('end', () => finishOnce('end'))
      .on('error', () => {
        finishOnce('upstream-error');
        res.destroy();
      })
      .pipe(res);
    res.on('close', () => finishOnce(res.writableFinished ? 'end' : 'client-closed'));
  }

  function models(res: http.ServerResponse): void {
    const chain = options.getChain();
    sendJson(res, 200, {
      object: 'list',
      data: chain
        ? [
            {
              id: chain.modelId,
              object: 'model',
              owned_by: 'boundary',
              ...(chain.contextLength ? { context_length: chain.contextLength } : {}),
            },
          ]
        : [],
    });
  }

  const server = http.createServer((req, res) => {
    const failure = checkBridgeRequest(req.headers, { port, token: options.token });
    if (failure) {
      sendError(res, failure.status, failure.reason);
      return;
    }
    const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '');
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      models(res);
      return;
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      completions(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 500, 'The inference router failed.');
        else res.destroy();
      });
      return;
    }
    sendError(res, 404, 'Not found.');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
