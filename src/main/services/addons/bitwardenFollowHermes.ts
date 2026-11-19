import type { HermesReplacedReason } from '../assistant/hermesLifecycle';
import type { PlainOutcome } from './addonScript';

// The Bitwarden broker runs in the hermes container's network namespace. When hermes is
// restarted or recreated, `vault.sh follow-hermes` moves the broker into the new one. At stack
// tag v0.3.14 it does nothing while BITWARDEN_ENABLED is off and exits non-zero only when the
// broker won't start.

export interface HermesFollowerDeps {
  /** False while Bitwarden is not offered or not enabled, or no stack root resolves. */
  active: () => boolean;
  run: () => Promise<PlainOutcome>;
  refresh: () => Promise<unknown>;
  /** Metadata only: reason, exit code, duration, error name. Never script output. */
  log: (message: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

export interface HermesFollower {
  /** Never rejects. */
  follow(reason: HermesReplacedReason): Promise<void>;
}

export function createHermesFollower(deps: HermesFollowerDeps): HermesFollower {
  const now = deps.now ?? Date.now;
  let inflight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  async function runOnce(reason: HermesReplacedReason): Promise<void> {
    const started = now();
    try {
      const outcome = await deps.run();
      deps.log('follow-hermes', { reason, code: outcome.code, ms: now() - started });
    } catch (error) {
      deps.log('follow-hermes', { reason, error: error instanceof Error ? error.name : 'unknown', ms: now() - started });
    }
    try {
      await deps.refresh();
    } catch (error) {
      deps.log('follow-hermes refresh failed', { reason, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  function start(reason: HermesReplacedReason): Promise<void> {
    const current: Promise<void> = runOnce(reason).finally(() => {
      if (inflight === current) inflight = null;
    });
    inflight = current;
    return current;
  }

  return {
    follow(reason) {
      if (!deps.active()) return Promise.resolve();
      // The queued run waits a microtask after `inflight` clears, so share it rather than start another.
      if (queued) return queued;
      if (!inflight) return start(reason);
      // A run is in flight: one more run follows it, and every call made meanwhile shares that run.
      queued = inflight.then(() => {
        queued = null;
        return start(reason);
      });
      return queued;
    },
  };
}
