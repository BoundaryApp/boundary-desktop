import { useEffect, useState } from 'react';
import type { CirclesResult, CirclesState } from '../../../shared/types/circles';

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

/** A result's error, or null when it succeeded. */
function resultError(result: CirclesResult<object>): string | null {
  // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
  return result.success === false ? result.error : null;
}

/** Runs a Circles call with a busy flag and the error it returns. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T extends object>(call: () => Promise<CirclesResult<T>>): Promise<CirclesResult<T> | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      setError(resultError(result));
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
