import type { BrokerCheckTrigger } from './bitwardenAddon';

// Boundary runs `vault.sh follow-hermes` after the hermes changes it makes itself. A hermes
// recreated from outside (`docker compose up -d --force-recreate hermes`) leaves the broker in
// the removed container's namespace, so browser sign-ins fail until something repairs it. This
// checks the namespace when a Boundary window gains focus, which is when someone comes back from
// the terminal, and every five minutes for chats that run while no window has focus.

/** How often the background check runs while Bitwarden is active. */
export const BROKER_POLL_MS = 5 * 60_000;
/** The least time between two checks, so switching windows back and forth doesn't run the container CLI each time. */
export const BROKER_CHECK_GAP_MS = 60_000;

export interface BrokerWatchDeps {
  /** False while Bitwarden is not offered or not enabled, or no stack root resolves. */
  active: () => boolean;
  /** Reads the namespace and repairs on a mismatch. */
  check: (trigger: BrokerCheckTrigger) => Promise<void>;
  /** Subscribes to window focus; returns the unsubscribe function. */
  onFocus: (listener: () => void) => () => void;
  /** Metadata only. */
  log: (message: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

/** Starts the focus listener and the poll; the returned function stops both. */
export function startBrokerWatch(deps: BrokerWatchDeps): () => void {
  const now = deps.now ?? (() => Date.now());
  let lastCheck: number | null = null;
  let inflight = false;

  const run = (trigger: BrokerCheckTrigger): void => {
    if (inflight || !deps.active()) return;
    const at = now();
    if (lastCheck !== null && at - lastCheck < BROKER_CHECK_GAP_MS) return;
    lastCheck = at;
    inflight = true;
    void deps
      .check(trigger)
      .catch((error: unknown) => deps.log('broker check failed', { trigger, error: error instanceof Error ? error.name : 'unknown' }))
      .finally(() => {
        inflight = false;
      });
  };

  const offFocus = deps.onFocus(() => run('focus'));
  const timer = setInterval(() => run('poll'), BROKER_POLL_MS);
  timer.unref?.();
  return () => {
    offFocus();
    clearInterval(timer);
  };
}
