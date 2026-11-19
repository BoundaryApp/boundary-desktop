import React from 'react';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';

/** The `/` list above the composer; one group so far, Writing voices (ADR 0056 §6). */
export const CommandMenu: React.FC<{
  query: string;
  items: WritingVoiceView[];
  index: number;
  /** The agent's own Chat replies voice, tagged in the list. */
  agentVoiceId: string | null;
  agentName: string;
  onPick: (voice: WritingVoiceView, keep: boolean) => void;
}> = ({ query, items, index, agentVoiceId, agentName, onPick }) => (
  <div className="wb-mentions wb-command-menu" role="listbox" aria-label="Commands">
    <div className="wb-mention-head">Writing voices</div>
    {items.length === 0 ? (
      <p className="wb-command-empty">No voice called “{query}”. Esc sends it as text.</p>
    ) : (
      items.map((voice, i) => (
        <button
          key={voice.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={i === index ? 'is-active' : undefined}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(voice, false);
          }}
        >
          <span>{voice.name}</span>
          {voice.id === agentVoiceId ? <span className="meta">{agentName} replies in this</span> : null}
        </button>
      ))
    )}
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
