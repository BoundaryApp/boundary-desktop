import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { SetupShell } from '../SetupShell';
import { SETUP_STEPS } from './index';
import { Button } from '../../components/ui/button';
import { StartupScreen } from '../../product/startup/StartupScreen';
import { useSetup } from '../SetupContext';
import type { SetupStepProps } from '../types';
import { assistantStackIPC } from '../../services/assistantStackIPCService';
import { createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import type { AssistantStackLifecycleSnapshot } from '../../../shared/types/assistantStack';

export const AssistantStackStep: React.FC<SetupStepProps> = ({ title, description }) => {
  const { assistantStackStatus, refreshAssistantStack } = useSetup();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<AssistantStackLifecycleSnapshot>(() =>
    createLifecycleSnapshot('idle')
  );
  const started = useRef(false);

  useEffect(() => {
    void assistantStackIPC.getLifecycle().then(setLifecycle);
    return assistantStackIPC.onLifecycle(setLifecycle);
  }, []);

  useEffect(() => {
    if (started.current) return;
    if (assistantStackStatus?.setupComplete && assistantStackStatus.ready) return;
    started.current = true;

    let cancelled = false;
    void (async () => {
      setRunning(true);
      setError(null);
      try {
        const result = await assistantStackIPC.ensureAndApplyLlm();
        if (cancelled) return;
        if (!result.success) {
          setError(result.error ?? 'Failed to start the assistant stack.');
          started.current = false;
        }
        await refreshAssistantStack();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          started.current = false;
        }
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assistantStackStatus?.ready, assistantStackStatus?.setupComplete, refreshAssistantStack]);

  const handleRetry = async () => {
    started.current = false;
    setRunning(true);
    setError(null);
    try {
      const result = await assistantStackIPC.ensureAndApplyLlm();
      if (!result.success) {
        setError(result.error ?? 'Failed to start the assistant stack.');
      }
      await refreshAssistantStack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      started.current = true;
    }
  };

  const services =
    lifecycle.services?.length > 0
      ? lifecycle.services
      : createLifecycleSnapshot('starting').services;

  const setupSteps = {
    steps: SETUP_STEPS.map((step) => ({ id: step.id, label: step.label })),
    currentId: 'assistant-stack',
  };
  const ready = Boolean(assistantStackStatus?.setupComplete && assistantStackStatus.ready);
  if (!error && (ready || running || lifecycle.phase === 'starting')) {
    return (
      <StartupScreen
        variant="first-run"
        stage={ready ? 'ready' : lifecycle.stage}
        stageStartedAt={lifecycle.stageStartedAt}
        message={lifecycle.message}
        services={services}
        download={lifecycle.download}
        setupSteps={setupSteps}
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
        onRetry={() => void handleRetry()}
        retrying={running}
        setupSteps={setupSteps}
      />
    );
  }

  return (
    <SetupShell
      title={title}
      description={description}
      actions={
        <Button type="button" onClick={() => void handleRetry()}>
          Start assistant
        </Button>
      }
    >
      <StackDetails>
        Boundary runs a dedicated Compose project (
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
