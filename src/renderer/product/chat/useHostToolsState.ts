import { useEffect, useState } from 'react';
import type { HostToolsState } from '../../../shared/types/hostBridge';
import { hostBridgeIPC } from '../../services/hostBridgeIPCService';

/**
 * Whether Hermes can use Boundary's host tools right now (ADR 0027). `null` until main answers,
 * or when there's no bridge API (tests, the browser build).
 */
export function useHostToolsState(): HostToolsState | null {
  const [state, setState] = useState<HostToolsState | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.hostBridge?.getToolsState) return;
    let current = true;
    // Subscribe first so a change during the initial read isn't lost.
    const unsubscribe = hostBridgeIPC.onToolsState((next) => {
      current = false;
      setState(next);
    });
    void hostBridgeIPC.getToolsState().then((initial) => {
      if (current) setState(initial);
    });
    return unsubscribe;
  }, []);

  return state;
}
