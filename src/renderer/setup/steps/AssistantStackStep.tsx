import React, { useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { SetupShell } from '../SetupShell';
import { setupSteps } from './index';
import { Button } from '../../components/ui/button';
import { StartupScreen } from '../../product/startup/StartupScreen';
import { startupServices } from '../../product/startup/startupModel';
import {
  useAssistantStackLifecycle,
  useAssistantStackStatus,
  useStackStart,
} from '../../product/assistantStack';
import type { SetupStepProps } from '../types';
import { APP_NAME } from '../../../shared/buildIdentity';

export const AssistantStackStep: React.FC<SetupStepProps> = ({ title, description }) => {
  const assistantStackStatus = useAssistantStackStatus();
  const lifecycle = useAssistantStackLifecycle();
  const { start, running, error } = useStackStart();
  const ready = Boolean(assistantStackStatus?.setupComplete && assistantStackStatus.ready);

  // Start once when the step opens; after that only Try again or Start assistant starts it.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || ready) return;
    autoStarted.current = true;
    void start();
  }, [ready, start]);

  const handleRetry = (): void => {
    void start();
  };
  const services = startupServices(lifecycle);

  const stepper = {
    steps: setupSteps().map((step) => ({ id: step.id, label: step.label })),
    currentId: 'assistant-stack',
  };
  if (!error && (ready || running || lifecycle.phase === 'starting')) {
    return (
      <StartupScreen
        variant="first-run"
        stage={ready ? 'ready' : lifecycle.stage}
        stageStartedAt={lifecycle.stageStartedAt}
        message={lifecycle.message}
        services={services}
        download={lifecycle.download}
        startTiming={lifecycle.startTiming}
        setupSteps={stepper}
      />
    );
  }

  if (error) {
    return (
      <StartupScreen
        variant="first-run"
        stage="error"
        message={lifecycle.message}
        services={services}
        error={error}
        onRetry={handleRetry}
        retrying={running}
        setupSteps={stepper}
      />
    );
  }

  return (
    <SetupShell
      title={title}
      description={description}
      actions={
        <Button type="button" onClick={handleRetry}>
          Start assistant
        </Button>
      }
    >
      <StackDetails>
        {APP_NAME} runs a dedicated Compose project (
        <code className="font-mono">boundary-assistant</code>) with its own data directory, so a
        local assistant checkout can keep running separately.
      </StackDetails>
    </SetupShell>
  );
};

/** Implementation detail kept one click away (ADR 0019). */
const StackDetails: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <details className="group text-xs text-fg-faint">
    <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm transition-colors duration-(--dur-fast) hover:text-fg-muted focus-visible:shadow-(--focus-ring) focus-visible:outline-none">
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 transition-transform duration-(--dur-fast) group-open:rotate-90"
      />
      Details
    </summary>
    <p className="mt-2 pl-4.5 leading-relaxed">{children}</p>
  </details>
);
