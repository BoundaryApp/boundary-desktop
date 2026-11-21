import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../lib/errorText';
import { useRestartWhenIdle } from './addons/useAddons';

interface AssistantRestartOptions {
  /**
   * A restart is on offer (pending changes, or the confirm step). A queued restart fires only
   * while this holds, and is dropped once it stops holding.
   */
  waiting: boolean;
  /** Called as a restart starts, whether from a click or a queue that fired. */
  onStart?: () => void;
  /** Called when the restart succeeded. */
  onRestarted?: () => void;
}

export interface AssistantRestart {
  /** Restarts now (`addons.applyPending`). */
  restart: () => void;
  /** Restarts once no agent work runs. */
  queue: () => void;
  queued: boolean;
  restarting: boolean;
  /** Why the last restart failed. */
  error: string | null;
  clearError: () => void;
}

export const RESTART_FAILED = 'The assistant didn’t restart.';

/**
 * The assistant restart that Settings › Assistant and the pending-changes bar both offer:
 * restart now, or queue it until running agent work finishes.
 */
export function useAssistantRestart({
  waiting,
  onStart,
  onRestarted,
}: AssistantRestartOptions): AssistantRestart {
  const [queued, setQueued] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onStart, onRestarted });
  callbacks.current = { onStart, onRestarted };

  // A queue is for what was waiting when it was made. Once that is gone, the next offer asks again.
  useEffect(() => {
    if (!waiting) setQueued(false);
  }, [waiting]);

  const restart = useCallback((): void => {
    setQueued(false);
    setRestarting(true);
    setError(null);
    callbacks.current.onStart?.();
    void window.electronAPI.addons
      .applyPending()
      .then((result) => {
        if (result.success) callbacks.current.onRestarted?.();
        else setError(result.error ?? RESTART_FAILED);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setRestarting(false));
  }, []);
  useRestartWhenIdle(queued, waiting, restart);

  const queue = useCallback(() => setQueued(true), []);
  const clearError = useCallback(() => setError(null), []);
  return { restart, queue, queued, restarting, error, clearError };
}
