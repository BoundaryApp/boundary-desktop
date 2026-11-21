import React from 'react';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';
import { Listbox, ListboxGroup, ListboxOption } from '../../components/ui/listbox';

/**
 * The `/` list above the composer; one group so far, Writing voices (ADR 0056 §6). The
 * composer keeps focus and names this list and its active row; `useCommandMenu` owns the keys.
 */
export const CommandMenu: React.FC<{
  listId: string;
  optionId: (index: number) => string;
  query: string;
  items: WritingVoiceView[];
  index: number;
  /** The agent's own Chat replies voice, tagged in the list. */
  agentVoiceId: string | null;
  agentName: string;
  onPick: (voice: WritingVoiceView, keep: boolean) => void;
}> = ({ listId, optionId, query, items, index, agentVoiceId, agentName, onPick }) => (
  <div className="wb-mentions wb-command-menu" onMouseDown={(event) => event.preventDefault()}>
    <Listbox id={listId} className="wb-list-inset" aria-label="Commands">
      <ListboxGroup label="Writing voices">
        {items.map((voice, i) => (
          <ListboxOption
            key={voice.id}
            id={optionId(i)}
            active={i === index}
            selected={i === index}
            onPick={() => onPick(voice, false)}
            hint={voice.id === agentVoiceId ? `${agentName} replies in this` : undefined}
          >
            {voice.name}
          </ListboxOption>
        ))}
      </ListboxGroup>
    </Listbox>
    {items.length === 0 ? (
      <p className="wb-command-empty">No voice called “{query}”. Esc sends it as text.</p>
    ) : null}
    <div className="wb-command-keys" aria-hidden="true">
      <span>
        <kbd>↵</kbd> this message
      </span>
      <span>
        <kbd>tab</kbd> keep for this chat
      </span>
      <span>
        <kbd>esc</kbd> close
      </span>
    </div>
  </div>
);
