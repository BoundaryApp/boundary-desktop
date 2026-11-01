import React, { useEffect } from 'react';
import type { AssistantStackLifecycleSnapshot } from '../../shared/types/assistantStack';
import { useStackStart } from './assistantStack';
import { StartupScreen } from './startup/StartupScreen';
import { startupServices } from './startup/startupModel';

export interface AssistantStackStartingScreenProps {
  lifecycle: AssistantStackLifecycleSnapshot;
}

export const AssistantStackStartingScreen: React.FC<AssistantStackStartingScreenProps> = ({
  lifecycle,
}) => {
  const { start, running, error: startError } = useStackStart();

  useEffect(() => {
    // If main has not started ensure yet (idle + not ready), kick it off.
    if (lifecycle.phase !== 'idle') return;
    void start('ensureRunning');
  }, [lifecycle.phase, start]);

  const error = startError ?? lifecycle.error ?? null;
  const isError = lifecycle.phase === 'error' || Boolean(error);

  return (
    <StartupScreen
      variant="launch"
      stage={isError ? 'error' : lifecycle.stage}
      stageStartedAt={lifecycle.stageStartedAt}
      message={lifecycle.message}
      services={startupServices(lifecycle)}
      download={lifecycle.download}
      startTiming={lifecycle.startTiming}
      error={error}
      onRetry={isError ? () => void start() : undefined}
      retrying={running}
    />
  );
};
