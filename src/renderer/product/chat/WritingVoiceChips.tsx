import React, { useState } from 'react';
import { Pin, X } from 'lucide-react';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';
import { openSettings } from '../settingsNavigation';
import { Button } from '../../components/ui/button';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../components/ui/menu';

/** A voice on the message being written (ADR 0056 §6): it covers that message's reply. */
export const MessageVoiceChip: React.FC<{
  name: string;
  onKeep: () => void;
  onRemove: () => void;
}> = ({ name, onKeep, onRemove }) => (
  <span className="wb-voice-chip">
    <span>✎ {name}</span>
    <Button type="button" variant="quiet" size="icon-xs" aria-label={`Keep ${name} for this chat`} title="Keep for this chat" onClick={onKeep}>
      <Pin className="size-3" aria-hidden="true" />
    </Button>
    <Button type="button" variant="quiet" size="icon-xs" aria-label={`Remove ${name}`} onClick={onRemove}>
      <X className="size-3" aria-hidden="true" />
    </Button>
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
  return (
    <span className="wb-kept-voice">
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger>
          <button type="button" className="wb-chip">
            ✎ {name}
          </button>
        </MenuTrigger>
        <MenuContent aria-label="This chat writes in" side="top" align="start">
          <MenuLabel>This chat writes in</MenuLabel>
          <MenuRadioGroup value={voiceId} onValueChange={(id) => onKeep(id || null)}>
            {voices
              .filter((v) => v.status === 'ready')
              .map((v) => (
                <MenuRadioItem key={v.id} value={v.id}>
                  {v.name}
                </MenuRadioItem>
              ))}
            <MenuRadioItem value="">Use {agentName}'s voice</MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem onSelect={() => openSettings({ tab: 'writing-voices' })}>Manage voices…</MenuItem>
        </MenuContent>
      </Menu>
    </span>
  );
};
