import {
  pushLlmProxyUpstream,
  readLlmProxyStatus,
  type LlmProxyStatus,
  type LlmProxyTarget,
  type LlmProxyUpstream,
} from './llmProxyAdmin';

/**
 * llm-proxy holds the upstream key in memory only, so a proxy restart (crash, Docker
 * restart, a compose recreate) comes back without it. While Boundary runs, this checks the
 * proxy now and then and pushes again after a restart.
 *
 * When Boundary isn't running, a restarted proxy has no key until Boundary next starts
 * (ADR 0026). With LLM_PROXY_AWAIT_PUSH set, its routes answer 503 until then.
 */

export const LLM_PROXY_KEEPER_INTERVAL_MS = 30_000;

export type LlmProxyCheck = 'idle' | 'ok' | 'repushed' | 'unreachable' | 'failed';

interface KeeperState {
  getTarget: () => LlmProxyTarget | null;
  upstream: LlmProxyUpstream;
  /** The proxy process our last successful push reached. */
  bootId?: string;
}

let state: KeeperState | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<LlmProxyCheck> | null = null;

/**
 * True when the proxy no longer serves what Boundary pushed.
 *
 * A proxy that reports `boot_id` (stack v0.3.0+) says so directly: it restarted, or a route
 * hasn't been pushed since it started. Until one of our pushes has succeeded, a route
 * pushed by someone else may hold another upstream, so that needs a push too.
 *
 * An older proxy is judged from its routes: a URL other than ours, or a missing key when
 * ours has one (a keyless local server never reports a key, so that alone is no reason to
 * push).
 */
export function proxyNeedsPush(
  status: LlmProxyStatus,
  upstream: LlmProxyUpstream,
  lastBootId?: string
): boolean {
  const routes = [status.chat, status.lightrag];
  if (status.proxy) {
    if (!lastBootId || status.proxy.bootId !== lastBootId) return true;
    return routes.some((route) => route.pushed === false);
  }
  return routes.some(
    (route) => route.url !== upstream.url || (Boolean(upstream.apiKey) && !route.apiKeySet)
  );
}

/**
 * Remember `upstream` as what the proxy should serve and start checking it. `getTarget`
 * is called on every check, so a changed admin port or token is picked up.
 */
export function keepLlmProxyUpstream(
  getTarget: () => LlmProxyTarget | null,
  upstream: LlmProxyUpstream,
  intervalMs = LLM_PROXY_KEEPER_INTERVAL_MS
): void {
  state = { getTarget, upstream };
  if (!timer) {
    timer = setInterval(() => {
      void checkLlmProxyUpstream();
    }, intervalMs);
    timer.unref?.();
  }
}

/** Record the proxy process a successful push reached, from the status it returned. */
export function noteLlmProxyPushed(status: LlmProxyStatus): void {
  if (state && status.proxy) state.bootId = status.proxy.bootId;
}

export function stopKeepingLlmProxyUpstream(): void {
  state = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Check the proxy once and push again if it lost the upstream. */
export function checkLlmProxyUpstream(): Promise<LlmProxyCheck> {
  if (!inFlight) {
    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runCheck(): Promise<LlmProxyCheck> {
  const current = state;
  const target = current?.getTarget();
  if (!current || !target) return 'idle';
  const status = await readLlmProxyStatus(target);
  if (!status.ok || !('status' in status)) return 'unreachable';
  if (!proxyNeedsPush(status.status, current.upstream, current.bootId)) return 'ok';
  const pushed = await pushLlmProxyUpstream(target, current.upstream);
  if (!pushed.ok || !('status' in pushed)) return 'failed';
  if (state === current) noteLlmProxyPushed(pushed.status);
  return 'repushed';
}

/** @internal Vitest only */
export function __resetLlmProxyKeeperForTests(): void {
  stopKeepingLlmProxyUpstream();
  inFlight = null;
}
