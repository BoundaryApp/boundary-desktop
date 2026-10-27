import { useEffect, useState } from 'react';
import type { HostToolsState } from '../../../shared/types/hostBridge';

/**
 * Whether Hermes can use Boundary's host tools right now (ADR 0027). `null` until main answers.
 * Main reports `stopped` while the user has stopped computer access, so the chat can point to
 * the setting instead of a restart.
 */
export function useHostToolsState(): HostToolsState | null {
  const [state, setState] = useState<HostToolsState | null>(null);

  useEffect(() => {
    let current = true;
    // Subscribe first so a change during the initial read isn't lost.
    const unsubscribe = window.electronAPI.hostBridge.onToolsState((next) => {
      current = false;
      setState(next);
    });
    void window.electronAPI.hostBridge.getToolsState().then((initial) => {
      if (current) setState(initial);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  return state;
}
