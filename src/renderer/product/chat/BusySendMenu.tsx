import React from 'react';
import { Checkbox } from '../../components/ui/checkbox';
import { Listbox, ListboxOption } from '../../components/ui/listbox';

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
 * arrows and Enter drive the list from the input, which names the list and its active row
 * (`listId`, `optionId`), and clicks never take focus from it. Always queue is a checkbox, so
 * it sits under the list rather than in it; Settings → Chat has the same switch for keyboards.
 */
export const BusySendMenu: React.FC<{
  listId: string;
  optionId: (index: number) => string;
  agentName: string;
  activeIndex: number;
  alwaysQueue: boolean;
  onPick: (choice: BusySendChoice) => void;
  onAlwaysQueueChange: (on: boolean) => void;
}> = ({ listId, optionId, agentName, activeIndex, alwaysQueue, onPick, onAlwaysQueueChange }) => (
  <div className="wb-busy-menu" onMouseDown={(event) => event.preventDefault()}>
    <div className="wb-busy-menu-kicker" aria-hidden="true">
      {agentName} is still replying
    </div>
    <Listbox id={listId} className="wb-list-inset" aria-label={`${agentName} is still replying`}>
      {BUSY_SEND_CHOICES.map((choice, index) => (
        <ListboxOption
          key={choice.id}
          id={optionId(index)}
          active={index === activeIndex}
          selected={index === activeIndex}
          className={choice.id === 'now' ? 'is-now' : undefined}
          onPick={() => onPick(choice.id)}
          description={choice.hint(agentName)}
          hint={<kbd className="wb-kbd">{choice.keys}</kbd>}
        >
          {choice.label}
        </ListboxOption>
      ))}
    </Listbox>
    <label className="wb-busy-menu-always">
      <Checkbox
        checked={alwaysQueue}
        onChange={(event) => onAlwaysQueueChange(event.target.checked)}
      />
      Always queue · don’t ask
      <span>Settings → Chat</span>
    </label>
  </div>
);
