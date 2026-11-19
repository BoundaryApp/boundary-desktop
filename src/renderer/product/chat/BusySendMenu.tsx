import React from 'react';

export type BusySendChoice = 'now' | 'queue' | 'cancel';

/** Most to least disruptive (spec decision 4); Add to this run joins in Phase 3. */
export const BUSY_SEND_CHOICES: ReadonlyArray<{
  id: BusySendChoice;
  label: string;
  hint: (agentName: string) => string;
  keys: string;
}> = [
  {
    id: 'now',
    label: 'Send now',
    hint: (name) => `Stops ${name} and sends this. What it wrote so far is kept.`,
    keys: '⌘↵',
  },
  { id: 'queue', label: 'Queue', hint: (name) => `Sends when ${name} finishes this reply.`, keys: '↵' },
  { id: 'cancel', label: 'Keep editing', hint: () => 'Closes this menu. Your message stays here.', keys: 'esc' },
];

/** Queue is preselected, so pressing Enter twice queues and never interrupts (spec 2.2). */
export const BUSY_SEND_DEFAULT_INDEX = 1;

/**
 * Enter with text while an agent replies (run-control spec 2.1). The composer keeps focus:
 * arrows and Enter drive the menu from the input, and clicks never take focus from it.
 */
export const BusySendMenu: React.FC<{
  agentName: string;
  activeIndex: number;
  alwaysQueue: boolean;
  onPick: (choice: BusySendChoice) => void;
  onAlwaysQueueChange: (on: boolean) => void;
}> = ({ agentName, activeIndex, alwaysQueue, onPick, onAlwaysQueueChange }) => (
  <div
    className="wb-busy-menu"
    role="menu"
    aria-label={`${agentName} is still replying`}
    onMouseDown={(event) => event.preventDefault()}
  >
    <div className="wb-busy-menu-kicker">{agentName} is still replying</div>
    {BUSY_SEND_CHOICES.map((choice, index) => (
      <button
        key={choice.id}
        type="button"
        role="menuitem"
        className={`${index === activeIndex ? 'is-active' : ''}${choice.id === 'now' ? ' is-now' : ''}`}
        onClick={() => onPick(choice.id)}
      >
        <b>{choice.label}</b>
        <kbd className="wb-kbd">{choice.keys}</kbd>
        <small>{choice.hint(agentName)}</small>
      </button>
    ))}
    <label className="wb-busy-menu-always">
      <input
        type="checkbox"
        checked={alwaysQueue}
        onChange={(event) => onAlwaysQueueChange(event.target.checked)}
      />
      Always queue · don’t ask
      <span>Settings → Chat</span>
    </label>
  </div>
);
