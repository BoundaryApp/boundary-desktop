import { useEffect, useState } from 'react';
import type { CirclesState } from '../../../shared/types/circles';

const STOPPED: CirclesState = {
  status: 'stopped',
  displayName: '',
  snapshot: { identity: '', circles: [] },
  providers: {},
  sharing: { models: [], circles: [], paused: false, away: false },
};

/** Main's Circles state, kept current from `circles:state`. */
export function useCirclesState(): CirclesState {
  const [state, setState] = useState<CirclesState>(STOPPED);
  useEffect(() => {
    let live = true;
    const off = window.electronAPI.circles.onState((next) => setState(next));
    void window.electronAPI.circles.getState().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** What `useAction().run` takes: a Circles result, or any other call's success flag and error. */
export type ActionResult = { success: boolean; error?: string };

/** A result's error, or null when it succeeded. */
function resultError(result: ActionResult, fallback: string): string | null {
  // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
  return result.success === false ? result.error || fallback : null;
}

/**
 * Runs a call with a busy flag and the error it returns or throws. A failed result comes back
 * as is; a throw comes back as null. `fallback` is shown when a failure has no error text.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <R extends ActionResult>(
    call: () => Promise<R>,
    fallback = 'Something went wrong.'
  ): Promise<R | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      setError(resultError(result, fallback));
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}
