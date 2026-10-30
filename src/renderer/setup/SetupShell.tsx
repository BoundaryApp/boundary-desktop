import React, { useState } from 'react';
import { Stepper } from '../components/ui/stepper';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { useOptionalSetup } from './SetupContext';
import { setupSteps } from './steps';
import { SetupBackgroundStatus } from './SetupBackgroundStatus';
import type { SetupStepId } from './types';
import '../product/chat/workbench.css';

export interface SetupShellProps {
  children: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  /** Left footer action. */
  onBack?: () => void;
  backLabel?: string;
  /** Right footer actions — the step's primary action goes last. */
  actions?: React.ReactNode;
  /** Stepper position; defaults to the active setup step. `null` hides the stepper. */
  step?: SetupStepId | null;
  /** `wide` (720px) for forms and service grids; default column is 560px. */
  width?: 'default' | 'wide';
  /** Centre the body vertically for short status views (loading, done). */
  centered?: boolean;
}

/**
 * Setup in the full-window frame (ADR 0029): the workbench's surface and type,
 * no app chrome, a stepper in the drag area and background start-up status.
 */
export const SetupShell: React.FC<SetupShellProps> = ({
  children,
  title,
  description,
  onBack,
  backLabel = 'Back',
  actions,
  step,
  width = 'default',
  centered = false,
}) => {
  const setup = useOptionalSetup();
  const activeStep = setup?.activeStep ?? null;
  // Read inside render: steps/ imports this module, so the step list is not
  // initialised yet while this file evaluates.
  // Optional steps carry the same weight in the stepper as required ones.
  const stepperSteps = setupSteps().map((item) => ({ id: item.id, label: item.label }));
  const currentStep = step === undefined ? (activeStep?.id ?? null) : step;
  const column = width === 'wide' ? 'max-w-[720px]' : 'max-w-[560px]';
  const skippable = Boolean(activeStep?.optional) && currentStep === activeStep?.id;
  const [skipping, setSkipping] = useState(false);
  const skip = () => {
    if (!setup || !currentStep) return;
    setSkipping(true);
    void setup.skipStep(currentStep).finally(() => setSkipping(false));
  };
  const hasFooter = Boolean(onBack || actions || skippable);

  return (
    <div className="workbench flex h-screen w-screen overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="wb-setup-head">
          {currentStep !== null && <Stepper steps={stepperSteps} currentId={currentStep} />}
          <div className="wb-setup-head-end">
            <SetupBackgroundStatus />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div
            className={cn(
              'mx-auto flex w-full flex-col px-6 py-10',
              column,
              centered && 'min-h-full justify-center'
            )}
          >
            <h1 className="text-heading font-medium text-fg">{title}</h1>
            {description && <p className="mt-2 text-ui text-fg-muted">{description}</p>}
            <div className="mt-6 flex flex-col gap-4">{children}</div>
          </div>
        </main>

        {hasFooter && (
          <footer className="shrink-0 bg-surface-0">
            <div className={cn('mx-auto flex w-full items-center gap-2 px-6 py-3', column)}>
              {onBack && (
                <Button type="button" variant="ghost" onClick={onBack}>
                  {backLabel}
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2">
                {skippable && (
                  <Button type="button" variant="ghost" disabled={skipping} onClick={skip}>
                    Skip for now
                  </Button>
                )}
                {actions}
              </div>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
};

/** Quiet inline spinner for loading bodies. */
export const SetupSpinner: React.FC<{ label: string; detail?: React.ReactNode }> = ({
  label,
  detail,
}) => (
  <div className="flex items-center gap-3 text-ui text-fg-muted" role="status">
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-line border-t-brand"
    />
    <div>
      <p>{label}</p>
      {detail && <p className="mt-0.5 text-xs text-fg-faint">{detail}</p>}
    </div>
  </div>
);
