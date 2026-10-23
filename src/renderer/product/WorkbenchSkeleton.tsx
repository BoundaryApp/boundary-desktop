import React, { useState } from 'react';
import { AlertCircle, ChevronRight } from 'lucide-react';
import type { AssistantStackServiceProgress, AssistantStackLifecycleStage } from '../../shared/types/assistantStack';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Stepper, type StepperStep } from '../components/ui/stepper';
import { ProductIconRail } from './ProductIconRail';
import { AssistantStackStageChecklist } from './AssistantStackStageChecklist';
import { ServiceProgressCards } from './ServiceProgressCards';
import './chat/workbench.css';

export interface WorkbenchSkeletonProps {
  stage?: AssistantStackLifecycleStage;
  message?: string | null;
  services: AssistantStackServiceProgress[];
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** Shown in the header while this is still a setup step. */
  setupSteps?: { steps: StepperStep[]; currentId: string };
}

/**
 * The workbench while the assistant stack starts (ADR 0019). Same rails and
 * composer as the ready app, greyed out, with start-up progress above the
 * composer — when the stack is ready the real workbench replaces it in place.
 */
export const WorkbenchSkeleton: React.FC<WorkbenchSkeletonProps> = ({
  stage,
  message,
  services,
  error,
  onRetry,
  retrying = false,
  setupSteps,
}) => {
  const [showServices, setShowServices] = useState(false);
  const isError = Boolean(error) || stage === 'error';

  return (
    <div className="workbench flex h-screen w-screen overflow-hidden" aria-busy={!isError}>
      <ProductIconRail active="chat" disabled />

      <aside className="wb-left" aria-hidden="true">
        <div className="wb-titlebar-spacer" />
        <div className="wb-skel-rail">
          <span className="wb-skel-bar" style={{ width: '72%' }} />
          <span className="wb-skel-label" />
          <span className="wb-skel-bar" style={{ width: '64%' }} />
          <span className="wb-skel-bar" style={{ width: '80%' }} />
          <span className="wb-skel-bar" style={{ width: '56%' }} />
          <span className="wb-skel-label" />
          <span className="wb-skel-bar" style={{ width: '68%' }} />
          <span className="wb-skel-bar" style={{ width: '48%' }} />
        </div>
      </aside>

      <main className="wb-center">
        <div className="wb-thread-head">
          {setupSteps ? (
            <Stepper steps={setupSteps.steps} currentId={setupSteps.currentId} />
          ) : (
            <strong>{isError ? 'Your assistant didn’t start' : 'Starting your assistant'}</strong>
          )}
        </div>

        <div className="wb-skel-log" />

        <section className="wb-skel-status" aria-live="polite">
          <div className="flex items-center gap-2 text-ui">
            {isError ? (
              <AlertCircle className="size-4 shrink-0 text-warn" aria-hidden="true" />
            ) : (
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-brand"
              />
            )}
            <span className="min-w-0 flex-1 text-fg-muted">
              {message ?? (isError ? 'Your assistant could not start.' : 'Starting assistant services…')}
            </span>
            <button
              type="button"
              className="wb-skel-toggle"
              aria-expanded={showServices}
              onClick={() => setShowServices((open) => !open)}
            >
              <ChevronRight aria-hidden="true" className="size-3.5" />
              {showServices ? 'Hide services' : 'Show services'}
            </button>
          </div>

          {!isError && <AssistantStackStageChecklist stage={stage} />}

          {showServices && <ServiceProgressCards services={services} tone="start" />}

          {error && <Callout variant="destructive">{error}</Callout>}

          {isError && onRetry && (
            <div>
              <Button type="button" onClick={onRetry} disabled={retrying}>
                {retrying ? 'Retrying…' : 'Try again'}
              </Button>
            </div>
          )}
        </section>

        <div className="wb-composer is-locked" aria-hidden="true">
          <textarea disabled placeholder="You can chat as soon as your assistant is ready." />
        </div>
      </main>
    </div>
  );
};
