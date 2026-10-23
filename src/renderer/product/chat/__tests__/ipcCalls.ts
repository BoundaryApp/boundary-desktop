import { act, configure, getConfig } from '@testing-library/react';

/**
 * IPC mocks wrapped in `track` stay pending here until they answer. `settle()` waits for all
 * of them and for React to render what they returned, so a test acts on the screen those
 * answers produce instead of racing them with a polling timeout. In the app they answer in
 * any order, and under load a fixed wait can expire before they do.
 *
 * Load it from a vi.mock factory with `await vi.hoisted(() => import('./ipcCalls'))`.
 */
const pending = new Set<Promise<unknown>>();
const held = new WeakSet<Promise<unknown>>();

/** Marks a reply the test answers by hand, or never, so `settle()` doesn't wait for it. */
export function hold<T>(promise: Promise<T>): Promise<T> {
  held.add(promise);
  return promise;
}

export function track<A extends unknown[], R>(f: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    const result = f(...args);
    if (result instanceof Promise && !held.has(result)) {
      pending.add(result);
      const done = () => pending.delete(result);
      result.then(done, done);
    }
    return result;
  };
}

/** Waits until every tracked call made so far, and any it led to, has answered. */
export async function settle(): Promise<void> {
  for (let round = 0; pending.size > 0; round += 1) {
    // Each round is one wave of calls that the previous answers led to; a screen that keeps
    // asking forever is a bug to report, not a reason to wait out the test timeout.
    if (round === 50) throw new Error(`IPC never settled: ${pending.size} calls still pending`);
    const inFlight = [...pending];
    await act(async () => {
      await Promise.allSettled(inFlight);
    });
  }
}

/**
 * Makes every waitFor and findBy settle tracked IPC first, so the wait's first check already
 * sees what the calls an interaction started have led to, however slowly the machine runs.
 */
export function settleBeforeWaits(): void {
  const wrap = getConfig().asyncWrapper;
  configure({
    asyncWrapper: async (callback) => {
      await settle();
      return wrap(callback);
    },
  });
}
