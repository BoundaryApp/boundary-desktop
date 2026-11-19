import React from 'react';
import type { HermesRunningTurn } from '../../../shared/types/hermesChat';

/**
 * How the dot reads: `live` pulses in the brand color; `quiet` pulses amber (alive but silent
 * for a while); `needs` is a still amber dot (waiting on you); `stalled` is a still red dot;
 * `held` is a hollow ring (sent, waiting in Boundary for the local model).
 */
export type WorkingDotTone = 'live' | 'quiet' | 'needs' | 'stalled' | 'held';

/** The working dot for a chat's running turn, hollow while the turn waits for its local model. */
export const RunningTurnDot: React.FC<{ turn: HermesRunningTurn | null; label: string }> = ({ turn, label }) => {
  if (!turn) return null;
  if (turn.admission === 'held') return <WorkingDot label="Waiting for the local model" tone="held" />;
  return <WorkingDot label={label} />;
};

/**
 * An agent is working on this chat right now. A dot with a soft pulse rather than a
 * spinner: it reads as live status, not as something the screen is waiting on, and it
 * stays legible at row size. Static under reduced motion.
 */
export const WorkingDot: React.FC<{ label: string; className?: string; tone?: WorkingDotTone }> = ({
  label,
  className,
  tone = 'live',
}) => (
  <span
    className={`wb-working-dot${tone === 'live' ? '' : ` is-${tone}`}${className ? ` ${className}` : ''}`}
    role="img"
    aria-label={label}
    title={label}
  />
);
