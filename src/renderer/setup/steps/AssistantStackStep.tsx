import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { SetupShell } from '../SetupShell';
import { SETUP_STEPS } from './index';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { WorkbenchSkeleton } from '../../product/WorkbenchSkeleton';
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

  if (assistantStackStatus?.setupComplete && assistantStackStatus.ready && !error) {
    const offset = assistantStackStatus.isolationMode === 'offset-ports';
    return (
      <SetupShell title="Your assistant is ready" centered>
        <div className="flex items-center gap-3 text-ui text-fg-muted" role="status">
          <CheckCircle2 className="size-5 text-ok" aria-label="Assistant stack ready" />
          <span>Opening Boundary…</span>
        </div>
        <StackDetails>
          Hermes API at <code className="font-mono">{assistantStackStatus.apiBaseUrl}</code>
          {offset ? ' (offset ports — a developer stack is using the defaults)' : ''}. Core, rag,
          automation, and coding profiles are up.
        </StackDetails>
      </SetupShell>
    );
  }

  const services =
    lifecycle.services?.length > 0
      ? lifecycle.services
      : createLifecycleSnapshot('starting').services;

  if (running || lifecycle.phase === 'starting') {
    return (
      <WorkbenchSkeleton
        stage={lifecycle.stage}
        message={lifecycle.message ?? 'Starting your assistant…'}
        services={services}
        setupSteps={{
          steps: SETUP_STEPS.map((step) => ({ id: step.id, label: step.label })),
          currentId: 'assistant-stack',
        }}
      />
    );
  }

  return (
    <SetupShell
      title={error ? 'Your assistant didn’t start' : title}
      description={description}
      actions={
        <Button type="button" onClick={() => void handleRetry()}>
          {error ? 'Try again' : 'Start assistant'}
        </Button>
      }
    >
      {error && <Callout variant="destructive">{error}</Callout>}
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
