import React from 'react';

/**
 * Send ↑ while idle, Stop ■ while a run is in flight (run-control spec 1.1). One element
 * whose glyph and label change, so keyboard focus survives the swap. A ring traces it
 * while the agent works; it pauses and turns amber while an approval waits.
 */
export const RunButton: React.FC<{
  running: boolean;
  held: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
}> = ({ running, held, canSend, onSend, onStop }) => {
  const tip = running
    ? held
      ? 'Stop · denies the pending request · Esc'
      : 'Stop · Esc'
    : canSend
      ? 'Send · Enter'
      : undefined;
  return (
    <button
      type="button"
      className={`wb-run${running ? ' is-run' : ''}${held ? ' is-held' : ''}`}
      aria-label={running ? 'Stop response' : 'Send message'}
      aria-disabled={!running && !canSend}
      data-tip={tip}
      onClick={running ? onStop : canSend ? onSend : undefined}
    >
      <span className="wb-run-ring" aria-hidden="true" />
      <svg className="wb-run-send" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 13V3.5M3.8 7.5L8 3.3l4.2 4.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg className="wb-run-stop" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <rect x="4" y="4" width="8" height="8" rx="1.6" />
      </svg>
    </button>
  );
};
