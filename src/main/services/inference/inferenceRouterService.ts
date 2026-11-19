import { randomBytes } from 'node:crypto';
import { persistDebugLog } from '../../persistDebugLog';
import { diag } from '../circles/circlesDiagnostics';
import { fetchSharedModel } from '../circles/circlesService';
import type { PoolMoveReason } from '../../../shared/types/confidential';
import type { PoolSender } from './confidential/poolSender';
import { startChainRouter, type ChainRouter, type RouterChain, type RouterServed } from './router/chainRouter';

/**
 * The one inference router Boundary runs while it is open (ADR 0033 §5). It starts the first
 * time a chain with more than one entry is applied and stops when Boundary quits. Its token
 * lives in memory and reaches llm-proxy as the upstream key, pushed like any other (ADR 0026).
 */

/** Hermes's `providers.<name>` entry that asks it to send the session header to llm-proxy. */
export const HERMES_ROUTER_PROVIDER_KEY = 'providers.boundary-chain';
export const HERMES_ROUTER_SESSION_HEADER = 'X-Boundary-Session';

let router: ChainRouter | null = null;
let starting: Promise<ChainRouter> | null = null;
let token = '';
let chain: RouterChain | null = null;
/** Chains served only to requests carrying their session key, from `routeOnce`. */
const onceChains = new Map<string, RouterChain>();
let lastServed: RouterServed | null = null;
/** The latest record for each session, oldest dropped first. */
const servedBySession = new Map<string, RouterServed>();
const SERVED_SESSION_LIMIT = 500;
/**
 * Per session, each request's pool move and who answered it, since they were last taken. A turn's
 * later requests stay on the provider the first one moved to and report no move, so the turn's
 * move is read from all of them. A room wake runs several agents in one turn, and each request can
 * land on another provider. Hermes also sends title and memory-review requests with the chat's
 * session key after a turn, which the next turn leaves out by their request time.
 */
interface PendingRequests {
  /** Each provider or entry that answered, with its latest request time. */
  providers: Map<string, number>;
  /** The newest moves in the order they were answered; older ones can't be a turn's last. */
  moves: Array<{ requestedAt: number; moved: PoolMoveReason }>;
}
const pendingRequests = new Map<string, PendingRequests>();
const PENDING_MOVES_LIMIT = 20;
let poolSender: PoolSender | null = null;
/** The router port llm-proxy was last pointed at by this run. */
let pushedPort: number | null = null;

export interface InferenceRouterEndpoint {
  port: number;
  token: string;
}

export async function ensureInferenceRouter(): Promise<InferenceRouterEndpoint> {
  if (router) return { port: router.port, token };
  if (!starting) {
    token = randomBytes(32).toString('base64url');
    starting = startChainRouter({
      token,
      getChain: (sessionKey) => (sessionKey ? onceChains.get(sessionKey) : undefined) ?? chain,
      peerFetch: (peer, body, signal) =>
        fetchSharedModel(peer, { method: 'POST', path: '/v1/chat/completions', body }, signal),
      poolFetch: (pool, body, signal, ctx) => {
        if (!poolSender) return Promise.resolve({ ok: false, outcome: { kind: 'unreachable' } });
        return poolSender.send(pool.modelId, body, signal, {
          sessionKey: ctx.sessionKey,
          privateProject: pool.privateProject,
          ...(pool.projectFloor ? { projectFloor: pool.projectFloor } : {}),
          ...(ctx.requestTokens === undefined ? {} : { requestTokens: ctx.requestTokens }),
          tools: Array.isArray(body.tools) && body.tools.length > 0,
        });
      },
      onServed: noteServed,
      log: (message, data) => persistDebugLog('inference-router', message, data),
      diag: (event, data) => diag(event, data),
    }).finally(() => {
      starting = null;
    });
  }
  router = await starting;
  return { port: router.port, token };
}

/** Sets `key` as the newest entry of `map`, dropping the oldest past the session limit. */
function setNewest<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > SERVED_SESSION_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function noteServed(served: RouterServed): void {
  // A once request its caller already released (timed out or cancelled) records nothing.
  if (served.sessionKey?.startsWith('once-') && !onceChains.has(served.sessionKey)) return;
  // A chat whose own record is missing falls back to the latest answer, which a once request
  // must not be.
  if (!served.sessionKey || !onceChains.has(served.sessionKey)) lastServed = served;
  if (!served.sessionKey) return;
  // Who answered each request: a pool's provider, or the entry for anything else, so a turn split
  // between a pool and another entry counts as mixed too.
  const pending = pendingRequests.get(served.sessionKey) ?? { providers: new Map<string, number>(), moves: [] };
  const provider = served.pool ? served.pool.providerId : `entry:${served.entryKey}`;
  pending.providers.set(provider, Math.max(pending.providers.get(provider) ?? 0, served.requestedAt));
  if (served.pool?.moved) {
    pending.moves.push({ requestedAt: served.requestedAt, moved: served.pool.moved });
    if (pending.moves.length > PENDING_MOVES_LIMIT) pending.moves.shift();
  }
  setNewest(pendingRequests, served.sessionKey, pending);
  // A request sent earlier whose answer came later (the last turn's title) isn't the latest.
  const kept = servedBySession.get(served.sessionKey);
  if (kept && kept.requestedAt > served.requestedAt) return;
  setNewest(servedBySession, served.sessionKey, served);
}

/** What the session's pool requests did since this was last called, for one turn. */
export interface RouterPoolTurn {
  /** The last pool move, or null. */
  moved: PoolMoveReason | null;
  /** More than one provider answered: two pool providers, or a pool and another entry. */
  mixedProviders: boolean;
}

/**
 * What the session's requests sent at or after `since` (the turn's start) did. Taking them clears every request kept for the session, earlier ones included.
 */
export function takeInferenceRouterPoolTurn(sessionKey: string, since: number): RouterPoolTurn {
  const pending = pendingRequests.get(sessionKey);
  pendingRequests.delete(sessionKey);
  if (!pending) return { moved: null, mixedProviders: false };
  const moved = pending.moves.filter((move) => move.requestedAt >= since).at(-1)?.moved ?? null;
  const providers = [...pending.providers.values()].filter((latest) => latest >= since);
  return { moved, mixedProviders: providers.length > 1 };
}

/** Where confidential pool entries are sent; without one they are unreachable. */
export function setInferenceRouterPoolSender(sender: PoolSender | null): void {
  poolSender = sender;
}

/** What the router serves from now on. Changing it needs no restart (ADR 0033 §9). */
export function setInferenceRouterChain(next: RouterChain | null): void {
  chain = next;
}

/**
 * Serves `onceChain` to requests carrying `sessionKey` until the returned release is called, for a
 * request that isn't a chat turn. Every other request, with another key or none, gets the chain
 * `setInferenceRouterChain` set. Releasing also forgets what the router recorded for the key.
 */
export function routeOnce(sessionKey: string, onceChain: RouterChain): () => void {
  onceChains.set(sessionKey, onceChain);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (onceChains.get(sessionKey) === onceChain) onceChains.delete(sessionKey);
    servedBySession.delete(sessionKey);
    pendingRequests.delete(sessionKey);
  };
}

/** What the router serves now to requests without a once key. */
export function inferenceRouterChain(): RouterChain | null {
  return chain;
}

export function noteInferenceRouterPushed(port: number): void {
  pushedPort = port;
}

/** llm-proxy points at the router running now, so a chain change needs no apply. */
export function inferenceRouterPushed(): boolean {
  return router !== null && pushedPort === router.port;
}

/**
 * The entry that served the router's most recent answer, for the chat's provenance line. With a
 * session key, that session's most recent answer; without one, the most recent of any session.
 */
export function latestInferenceRouterServed(sessionKey?: string | null): RouterServed | null {
  if (!sessionKey) return lastServed;
  return servedBySession.get(sessionKey) ?? null;
}

/** llm-proxy's upstream URL for the router, as a container reaches the host. */
export function inferenceRouterProxyUrl(port: number): string {
  return `http://host.docker.internal:${port}/v1`;
}

export async function stopInferenceRouter(): Promise<void> {
  const running = router;
  router = null;
  chain = null;
  onceChains.clear();
  lastServed = null;
  servedBySession.clear();
  pendingRequests.clear();
  pushedPort = null;
  await running?.close();
}
