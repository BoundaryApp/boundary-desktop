import React from 'react';
import type { AssistantStackLifecycleSnapshot } from '../../shared/types/assistantStack';
import { createLifecycleSnapshot } from '../../shared/assistantStackLifecycle';
import { ServiceProgressCards } from './ServiceProgressCards';
import { Pill } from '../components/ui/badge';

export interface AssistantStackQuitOverlayProps {
  lifecycle: AssistantStackLifecycleSnapshot;
}

export const AssistantStackQuitOverlay: React.FC<AssistantStackQuitOverlayProps> = ({
  lifecycle,
}) => {
  if (lifecycle.phase !== 'stopping' && lifecycle.phase !== 'stopped') {
    return null;
  }

  const services =
    lifecycle.services?.length > 0
      ? lifecycle.services
      : createLifecycleSnapshot('stopping').services;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0/90 px-6 py-10 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quit-overlay-title"
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 text-fg">
        <div>
          <Pill variant="warn" dot>
            Quitting
          </Pill>
          <h2 id="quit-overlay-title" className="mt-3 text-heading font-medium">
            Shutting down your assistant
          </h2>
          <p className="mt-2 text-ui text-fg-muted">
            Services are stopping and temporary data is being cleaned up. Boundary closes when
            this finishes.
          </p>
          {lifecycle.message && (
            <p className="mt-2 text-ui text-fg-faint">{lifecycle.message}</p>
          )}
        </div>
        <ServiceProgressCards services={services} tone="stop" />
      </div>
    </div>
  );
};
