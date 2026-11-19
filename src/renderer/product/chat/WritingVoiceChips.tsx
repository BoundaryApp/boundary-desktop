import React, { useEffect, useRef, useState } from 'react';
import { Pin, X } from 'lucide-react';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';
import { openSettings } from '../settingsNavigation';
import { useOwnerDocument } from '../../components/ui/ownerDocument';

/** A voice on the message being written (ADR 0056 §6): it covers that message's reply. */
export const MessageVoiceChip: React.FC<{
  name: string;
  onKeep: () => void;
  onRemove: () => void;
}> = ({ name, onKeep, onRemove }) => (
  <span className="wb-voice-chip">
    <span>✎ {name}</span>
    <button type="button" aria-label={`Keep ${name} for this chat`} title="Keep for this chat" onClick={onKeep}>
      <Pin aria-hidden="true" />
    </button>
    <button type="button" aria-label={`Remove ${name}`} onClick={onRemove}>
      <X aria-hidden="true" />
    </button>
  </span>
);

/** The voice kept for this chat, beside the project and model chips, with a menu to change it. */
export const KeptVoiceChip: React.FC<{
  name: string;
  voiceId: string;
  voices: WritingVoiceView[];
  agentName: string;
  onKeep: (voiceId: string | null) => void;
}> = ({ name, voiceId, voices, agentName, onKeep }) => {
  const [open, setOpen] = useState(false);
  const ownerDocument = useOwnerDocument();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    ownerDocument.addEventListener('mousedown', onDown);
    return () => ownerDocument.removeEventListener('mousedown', onDown);
  }, [open, ownerDocument]);

  const choose = (id: string | null) => {
    setOpen(false);
    onKeep(id);
  };

  return (
    <span className="wb-kept-voice" ref={ref}>
      <button type="button" className="wb-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ✎ {name}
      </button>
      {open ? (
        <div className="wb-kept-voice-menu" role="menu" aria-label="This chat writes in">
          <div className="wb-mention-head">This chat writes in</div>
          {voices
            .filter((v) => v.status === 'ready')
            .map((v) => (
              <button
                key={v.id}
                type="button"
                role="menuitem"
                aria-current={v.id === voiceId ? 'true' : undefined}
                className={v.id === voiceId ? 'is-active' : undefined}
                onClick={() => choose(v.id)}
              >
                {v.name}
              </button>
            ))}
          <hr />
          <button type="button" role="menuitem" onClick={() => choose(null)}>
            Use {agentName}'s voice
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openSettings({ tab: 'writing-voices' });
            }}
          >
            Manage voices…
          </button>
        </div>
      ) : null}
    </span>
  );
};
