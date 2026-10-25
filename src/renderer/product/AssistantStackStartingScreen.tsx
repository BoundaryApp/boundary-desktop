import React, { useCallback, useEffect, useState } from 'react';
import { useSetup } from '../setup/SetupContext';
import { assistantStackIPC } from '../services/assistantStackIPCService';
import { createLifecycleSnapshot } from '../../shared/assistantStackLifecycle';
import type { AssistantStackLifecycleSnapshot } from '../../shared/types/assistantStack';
import { StartupScreen } from './startup/StartupScreen';

export interface AssistantStackStartingScreenProps {
  lifecycle: AssistantStackLifecycleSnapshot;
}

export const AssistantStackStartingScreen: React.FC<AssistantStackStartingScreenProps> = ({
  lifecycle,
}) => {
  const { refreshAssistantStack } = useSetup();
  const [retrying, setRetrying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    // If main has not started ensure yet (idle + not ready), kick it off.
    if (lifecycle.phase !== 'idle') return;
    let cancelled = false;
    void (async () => {
      try {
        await assistantStackIPC.ensureRunning();
        if (!cancelled) {
          await refreshAssistantStack();
        }
      } catch (err) {
        if (!cancelled) {
          setLocalError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lifecycle.phase, refreshAssistantStack]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setLocalError(null);
    try {
      const result = await assistantStackIPC.ensureAndApplyLlm();
      if (!result.success) {
        setLocalError(result.error ?? 'Failed to start the assistant stack.');
      }
      await refreshAssistantStack();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [refreshAssistantStack]);

  const services =
    lifecycle.services?.length > 0
      ? lifecycle.services
      : createLifecycleSnapshot('starting').services;
  const error = localError ?? lifecycle.error ?? null;
  const isError = lifecycle.phase === 'error' || Boolean(error);

  return (
    <StartupScreen
      variant="launch"
      stage={isError ? 'error' : lifecycle.stage}
      stageStartedAt={lifecycle.stageStartedAt}
      message={lifecycle.message}
      services={services}
      download={lifecycle.download}
      error={error}
      onRetry={isError ? () => void handleRetry() : undefined}
      retrying={retrying}
    />
  );
};
