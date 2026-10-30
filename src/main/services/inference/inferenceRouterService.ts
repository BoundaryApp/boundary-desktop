import { randomBytes } from 'node:crypto';
import { persistDebugLog } from '../../persistDebugLog';
import { diag } from '../circles/circlesDiagnostics';
import { fetchSharedModel } from '../circles/circlesService';
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
let lastServed: RouterServed | null = null;
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
      getChain: () => chain,
      peerFetch: (peer, body, signal) =>
        fetchSharedModel(peer, { method: 'POST', path: '/v1/chat/completions', body }, signal),
      onServed: (served) => {
        lastServed = served;
      },
      log: (message, data) => persistDebugLog('inference-router', message, data),
      diag: (event, data) => diag(event, data),
    }).finally(() => {
      starting = null;
    });
  }
  router = await starting;
  return { port: router.port, token };
}

/** What the router serves from now on. Changing it needs no restart (ADR 0033 §9). */
export function setInferenceRouterChain(next: RouterChain | null): void {
  chain = next;
}

export function noteInferenceRouterPushed(port: number): void {
  pushedPort = port;
}

/** llm-proxy points at the router running now, so a chain change needs no apply. */
export function inferenceRouterPushed(): boolean {
  return router !== null && pushedPort === router.port;
}

/** The entry that served the router's most recent answer, for the chat's provenance line. */
export function latestInferenceRouterServed(): RouterServed | null {
  return lastServed;
}

/** llm-proxy's upstream URL for the router, as a container reaches the host. */
export function inferenceRouterProxyUrl(port: number): string {
  return `http://host.docker.internal:${port}/v1`;
}

export async function stopInferenceRouter(): Promise<void> {
  const running = router;
  router = null;
  chain = null;
  lastServed = null;
  pushedPort = null;
  await running?.close();
}
