import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ASSISTANT_STACK_ALREADY_RUNNING_ADVANCE_MS } from '../../../shared/assistantStackRequirements';
import { formatLocalLlmNames } from '../../../shared/localLlm';
import { SetupShell, SetupSpinner } from '../SetupShell';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { useSetup } from '../SetupContext';
import type { SetupStepProps } from '../types';
import { DebugLogCopy } from '../../components/settings/DebugLogCopy';

export const CapabilityStep: React.FC<SetupStepProps> = ({ title, description }) => {
  const {
    capabilityAssessment,
    capabilityLoading,
    capabilityError,
    provisionProgress,
    capabilityStatus,
    localLlms,
    assessCapability,
    acknowledgeCapability,
  } = useSetup();
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackError, setAckError] = useState<string | null>(null);
  const autoAdvanceStarted = useRef(false);

  const handleContinue = async () => {
    setAcknowledging(true);
    setAckError(null);
    try {
      const result = await acknowledgeCapability();
      if (!result.success) {
        setAckError(result.error ?? 'Unable to continue.');
      }
    } catch (err) {
      setAckError(err instanceof Error ? err.message : String(err));
    } finally {
      setAcknowledging(false);
    }
  };

  useEffect(() => {
    if (!capabilityAssessment?.stackAlreadyRunning || autoAdvanceStarted.current) {
      return;
    }
    autoAdvanceStarted.current = true;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      void (async () => {
        setAcknowledging(true);
        setAckError(null);
        try {
          const result = await acknowledgeCapability();
          if (!result.success) {
            setAckError(result.error ?? 'Unable to continue.');
            autoAdvanceStarted.current = false;
          }
        } catch (err) {
          setAckError(err instanceof Error ? err.message : String(err));
          autoAdvanceStarted.current = false;
        } finally {
          setAcknowledging(false);
        }
      })();
    }, ASSISTANT_STACK_ALREADY_RUNNING_ADVANCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [acknowledgeCapability, capabilityAssessment?.stackAlreadyRunning]);

  const errorText = ackError ?? capabilityError;

  if (capabilityLoading || !capabilityAssessment) {
    return (
      <SetupShell title={title} description={description} centered>
        <SetupSpinner
          label="Checking this Mac…"
          detail={provisionProgress ?? 'Container runtime, memory, CPU, and free disk'}
        />
      </SetupShell>
    );
  }

  if (capabilityAssessment.stackAlreadyRunning) {
    return (
      <SetupShell title="Your assistant is already running" centered>
        <div className="flex items-center gap-3 text-ui text-fg-muted" role="status">
          <CheckCircle2 className="size-5 text-ok" aria-label="Assistant stack is running" />
          <span>{acknowledging ? 'Continuing…' : 'Continuing in a few seconds…'}</span>
        </div>
        {errorText && <Callout variant="destructive">{errorText}</Callout>}
      </SetupShell>
    );
  }

  const checks = (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-1">
      {capabilityAssessment.checks.map((check) => (
        <li key={check.id} className="flex items-start gap-3 px-4 py-3">
          {check.passed ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="Passed" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-label="Below recommended" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-medium text-fg">{check.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                {check.actual}
                <span className="text-fg-faint"> / {check.required}</span>
              </span>
            </div>
            {check.detail && <p className="mt-1 text-xs text-fg-faint">{check.detail}</p>}
          </div>
        </li>
      ))}
    </ul>
  );

  if (!capabilityAssessment.passed) {
    return (
      <SetupShell
        title="This Mac is below the recommended specs"
        description="You can continue. Some assistant services may start slowly or fail until the items marked below are fixed."
        actions={
          <>
            <Button type="button" variant="outline" onClick={() => void assessCapability()}>
              Check again
            </Button>
            <Button type="button" disabled={acknowledging} onClick={() => void handleContinue()}>
              {acknowledging ? 'Continuing…' : 'Continue anyway'}
            </Button>
          </>
        }
      >
        {errorText && <Callout variant="destructive">{errorText}</Callout>}
        {checks}
        <DebugLogCopy path={capabilityStatus?.debugLogPath} />
      </SetupShell>
    );
  }

  return (
    <SetupShell
      title={title}
      description={description}
      actions={
        <Button type="button" disabled={acknowledging} onClick={() => void handleContinue()}>
          {acknowledging ? 'Continuing…' : 'Continue'}
        </Button>
      }
    >
      {errorText && <Callout variant="destructive">{errorText}</Callout>}
      {provisionProgress &&
        !capabilityAssessment.checks.some((check) => check.detail === provisionProgress) && (
          <Callout variant="ok">{provisionProgress}</Callout>
        )}
      {localLlms.length > 0 && (
        <Callout variant="info">
          {formatLocalLlmNames(localLlms)} detected. You can use{' '}
          {localLlms.length === 1 ? 'it' : 'them'} as your model on the next step.
        </Callout>
      )}
      {checks}
    </SetupShell>
  );
};
