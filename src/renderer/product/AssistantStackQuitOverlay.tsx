import React, { useRef, useState } from 'react';
import type { AssistantStackLifecycleSnapshot } from '../../shared/types/assistantStack';
import { createLifecycleSnapshot } from '../../shared/assistantStackLifecycle';
import { ServiceProgressCards } from './ServiceProgressCards';
import { StartupDetails, ToolRing } from './startup/StartupScreen';
import { STARTUP_TOOLS, toolState, type StartupToolState } from './startup/startupModel';
import { useUpdates } from './updates';
import { APP_NAME } from '../../shared/buildIdentity';

export interface AssistantStackQuitOverlayProps {
  lifecycle: AssistantStackLifecycleSnapshot;
}

/** In a stop wave `done` means stopped, so the ring empties as tools shut down. */
const STOP_TILE: Record<StartupToolState, StartupToolState> = {
  done: 'pending',
  working: 'working',
  pending: 'done',
  error: 'error',
};

const STOP_WORDS: Record<StartupToolState, string> = {
  done: 'running',
  working: 'stopping',
  pending: 'stopped',
  error: 'failed to stop',
};

/**
 * Quitting (ADR 0029): the start-up screen in reverse. Tiles go dark as their
 * containers stop and the assistant falls asleep; Boundary closes when it ends.
 */
export const AssistantStackQuitOverlay: React.FC<AssistantStackQuitOverlayProps> = ({
  lifecycle,
}) => {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const update = useUpdates();
  const highWater = useRef(0);
  if (lifecycle.phase !== 'stopping' && lifecycle.phase !== 'stopped') {
    highWater.current = 0;
    return null;
  }

  const services =
    lifecycle.services?.length > 0
      ? lifecycle.services
      : createLifecycleSnapshot('stopping').services;
  const states = STARTUP_TOOLS.map((tool) => STOP_TILE[toolState(tool, services)]);
  const mean =
    lifecycle.phase === 'stopped'
      ? 1
      : services.reduce((sum, s) => sum + Math.min(1, Math.max(0, s.progress)), 0) /
        Math.max(1, services.length);
  highWater.current = Math.max(highWater.current, mean);
  const pct = Math.round(highWater.current * 100);

  return (
    <div
      className="su-root su-overlay"
      data-state="working"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quit-overlay-title"
    >
      <div className="su-column">
        <ToolRing states={states} highlighted={-1} lookAt={-1} mood="sleeping" words={STOP_WORDS} />
        <div className="su-heading">
          <h1 id="quit-overlay-title">Shutting down your assistant</h1>
          <p role="status">
            {update?.phase === 'ready'
              ? `Stopping your tools. ${APP_NAME} installs ${update.version} and ${update.restarting ? 'reopens' : 'closes'}.`
              : `Stopping your tools. ${APP_NAME} closes when this finishes.`}
          </p>
        </div>
        <div
          className="su-bar"
          role="progressbar"
          aria-label="Shut-down progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
        <div className="su-footer">
          <StartupDetails open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}>
            {lifecycle.message && <p className="su-log">{lifecycle.message}</p>}
            <ServiceProgressCards services={services} tone="stop" />
          </StartupDetails>
        </div>
      </div>
    </div>
  );
};
