import { useCallback, useEffect, useRef, useState } from 'react';
import { createLifecycleSnapshot } from '../../shared/assistantStackLifecycle';
import type {
  AssistantStackLifecycleSnapshot,
  AssistantStackStatus,
} from '../../shared/types/assistantStack';
import { createIpcStore, useIpcStore } from '../lib/ipcStore';

/**
 * The assistant stack as the renderer sees it: the lifecycle main pushes, and the status
 * snapshot, fetched at start, refetched when the lifecycle phase changes or main sees the
 * stack's health check change, and replaced by the status a start returns. One subscription
 * for setup, the start-up screen and product screens.
 */

const lifecycleStore = createIpcStore<AssistantStackLifecycleSnapshot>({
  initial: createLifecycleSnapshot('idle'),
  start: (store) => {
    let pushed = false;
    window.electronAPI.assistantStack.onLifecycle((snapshot) => {
      pushed = true;
      const phaseChanged = snapshot.phase !== store.get().phase;
      store.set(snapshot);
      if (phaseChanged) void refreshAssistantStackStatus();
    });
    void window.electronAPI.assistantStack
      .getLifecycle()
      .then((snapshot) => {
        // A pushed snapshot is newer than this answer.
        if (snapshot && !pushed) store.set(snapshot);
      })
      .catch((): void => undefined);
  },
});

interface StatusState {
  status: AssistantStackStatus | null;
  /** False until the first fetch answers, so setup doesn't read a missing status as "not set up". */
  loaded: boolean;
}

// Each fetch or taken status takes a number; a fetch answer older than the latest is dropped.
let generation = 0;

const statusStore = createIpcStore<StatusState>({
  initial: { status: null, loaded: false },
  start: (store) => {
    lifecycleStore.start();
    window.electronAPI.assistantStack.onReady((ready) => {
      // A fetch of the status checks health itself; skip one that would change nothing.
      if (store.get().status?.ready !== ready) void refreshAssistantStackStatus();
    });
    void refreshAssistantStackStatus();
  },
});

export async function refreshAssistantStackStatus(): Promise<void> {
  const mine = ++generation;
  let status: AssistantStackStatus | null;
  try {
    status = await window.electronAPI.assistantStack.getStatus();
  } catch {
    status = null;
  }
  if (mine === generation) statusStore.set({ status, loaded: true });
}

function takeStatus(status: AssistantStackStatus): void {
  generation += 1;
  statusStore.set({ status, loaded: true });
}

export function useAssistantStackLifecycle(): AssistantStackLifecycleSnapshot {
  return useIpcStore(lifecycleStore);
}

export function useAssistantStackStatus(): AssistantStackStatus | null {
  return useIpcStore(statusStore).status;
}

/** False until the first status fetch has answered. */
export function useAssistantStackStatusLoaded(): boolean {
  return useIpcStore(statusStore).loaded;
}

export const STACK_START_FAILED = 'Failed to start the assistant stack.';

/**
 * Start the stack, keep the error to show, and take the status the start returns. `ensureRunning`
 * starts it as it is configured; `ensureAndApplyLlm` (the default) also applies the chosen model.
 */
export function useStackStart(): {
  start: (call?: 'ensureRunning' | 'ensureAndApplyLlm') => Promise<boolean>;
  running: boolean;
  error: string | null;
} {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(async (call: 'ensureRunning' | 'ensureAndApplyLlm' = 'ensureAndApplyLlm') => {
    setRunning(true);
    setError(null);
    let failure: string | null = null;
    try {
      const result = await window.electronAPI.assistantStack[call]();
      if (!result.success) failure = result.error ?? STACK_START_FAILED;
      // A start that threw in main comes back without a status.
      if (result.status) takeStatus(result.status);
      else await refreshAssistantStackStatus();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (mounted.current) {
      setError(failure);
      setRunning(false);
    }
    return failure === null;
  }, []);

  return { start, running, error };
}
