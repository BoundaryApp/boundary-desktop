import React from 'react';
import type { CodingAgentBusy } from '../../../shared/types/codingFolders';

/**
 * The wait-or-stop choice every coding-grant entry point offers when a coding task is running:
 * a warning, then "… when it finishes" and "Stop task and …". The warning and the buttons sit
 * in different rows of each host, so they are two parts. `look` picks the host's own classes:
 * an add sheet, a chat interrupt card, or the rail's popover.
 */

export type CodingBusyLook = 'sheet' | 'interrupt' | 'popover';
/** What the change does: adds a folder, or allows coding in the project's own folder. */
export type CodingBusyVerb = 'add' | 'allow';

const WARNING_CLASS: Record<CodingBusyLook, string> = {
  sheet: 'wb-insp-banner warn wb-sheet-banner',
  interrupt: 'why is-warn',
  popover: 'wb-popover-warn',
};

const BUTTON_CLASS: Record<CodingBusyLook, { queue: string; stop: string }> = {
  sheet: { queue: 'wb-btn-solid', stop: 'wb-btn-ghost' },
  interrupt: { queue: 'run', stop: 'more' },
  popover: { queue: 'wb-btn-solid', stop: 'wb-btn-ghost' },
};

export const CodingBusyWarning: React.FC<{
  agent: CodingAgentBusy;
  verb: CodingBusyVerb;
  look: CodingBusyLook;
}> = ({ agent, verb, look }) => {
  const text = (
    <>
      A coding task is running
      {agent.sessions.length ? ` (${agent.sessions.join(', ')})` : ''}.{' '}
      {verb === 'allow' ? 'Allowing coding' : 'Adding the folder'} restarts the coding agent,
      which stops that task.
    </>
  );
  // The sheet's banner wraps its text; the other hosts style the paragraph itself.
  return look === 'sheet' ? (
    <div className={WARNING_CLASS.sheet}>
      <p>{text}</p>
    </div>
  ) : (
    <p className={WARNING_CLASS[look]}>{text}</p>
  );
};

export const CodingBusyButtons: React.FC<{
  verb: CodingBusyVerb;
  look: CodingBusyLook;
  onChoose: (mode: 'queue' | 'stop') => void;
  /** The change is already waiting for the task. */
  queued?: boolean;
  disabled?: boolean;
}> = ({ verb, look, onChoose, queued = false, disabled = false }) => {
  const label = verb === 'allow' ? 'Allow' : 'Add';
  const queue = (
    <button
      type="button"
      className={BUTTON_CLASS[look].queue}
      disabled={disabled}
      onClick={() => onChoose('queue')}
    >
      {queued ? 'Waiting for it to finish…' : `${label} when it finishes`}
    </button>
  );
  const stop = (
    <button
      type="button"
      className={BUTTON_CLASS[look].stop}
      disabled={disabled}
      onClick={() => onChoose('stop')}
    >
      Stop task and {verb}
    </button>
  );
  // Sheets and popovers end on their solid button; the interrupt card leads with it.
  return look === 'interrupt' ? (
    <>
      {queue}
      {stop}
    </>
  ) : (
    <>
      {stop}
      {queue}
    </>
  );
};
