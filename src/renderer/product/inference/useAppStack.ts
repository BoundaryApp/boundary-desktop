import { useCallback, useEffect, useState } from 'react';
import type { InferenceChainEntry, InferenceStack } from '../../../shared/types/inferenceChain';
import { runAppSwitch } from '../../onboarding/appSwitch';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useCirclesState } from '../circles/useCircles';
import { stackChange, storedStack } from './stack';

/**
 * The app's stack for Inference: what the store holds, main's description of each entry, and
 * saving a new order. A new first entry runs the app switch; the rest saves the fallbacks.
 */
export function useAppStack() {
  const { status } = useInferenceStatus();
  const circles = useCirclesState();
  const [described, setDescribed] = useState<InferenceStack | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = storedStack(status);

  // Main's view changes with the store, slot health and Circles, so ask again when any does.
  useEffect(() => {
    let live = true;
    void window.electronAPI.onboarding
      .describeAppStack()
      .then((next) => {
        if (live) setDescribed(next);
      })
      .catch((): undefined => undefined);
    return () => {
      live = false;
    };
  }, [status, circles]);

  const save = useCallback(
    async (next: InferenceChainEntry[]) => {
      const { first, fallbacks } = stackChange(list, next);
      setBusy(true);
      setError(null);
      setNotice(null);
      const saveFallbacks = async (): Promise<boolean> => {
        const saved = await window.electronAPI.onboarding.setAppFallbacks({ fallbacks });
        if (!saved.success) {
          setError(saved.error ?? 'Unable to save the stack.');
          return false;
        }
        await takeInferenceStatus(saved);
        return true;
      };
      try {
        if (!first) {
          if (await saveFallbacks()) setNotice('Saved. It applies to your next message.');
          return;
        }
        // Switch first: a cancelled or failed switch then leaves the stack as it was.
        const outcome = await runAppSwitch(
          first,
          list[0] ?? null,
          () =>
            first.slot === 'peer'
              ? window.electronAPI.onboarding.setAppSharedModel({ entry: first })
              : window.electronAPI.onboarding.setAppDefault({ slot: first.slot }),
          'Unable to change the first model.'
        );
        if (outcome.cancelled) return;
        if (outcome.error) {
          setError(outcome.error);
          return;
        }
        if (!(await saveFallbacks())) return;
        if (outcome.deferred) setNotice('Saved. A reply is still running, so the change applies to your next message.');
        else setNotice('Saved. The assistant now starts with the first model.');
      } finally {
        setBusy(false);
      }
    },
    [list]
  );

  return { status, circles, list, described, busy, error, notice, save };
}
