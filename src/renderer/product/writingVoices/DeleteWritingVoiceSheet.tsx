import React, { useEffect, useState } from 'react';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import type { WritingVoiceUser, WritingVoiceView } from '../../../shared/types/writingVoices';

const USE_TEXT = { 'chat-replies': 'chat replies', drafts: 'drafts' } as const;

/** "Juniper's chat replies and Marlow's chat replies and drafts go back to No voice." */
function usersLine(users: WritingVoiceUser[]): string | null {
  if (users.length === 0) return null;
  const clauses = users.map((u) => `${u.displayName}'s ${u.uses.map((use) => USE_TEXT[use]).join(' and ')}`);
  return `${clauses.join(' and ')} go back to No voice.`;
}

/** Delete… on a voice card (ADR 0056 §10): the folder goes to the Trash. */
export const DeleteWritingVoiceSheet: React.FC<{
  voice: WritingVoiceView;
  open: boolean;
  onClose: () => void;
  onDeleted: (id: string) => void;
}> = ({ voice, open, onClose, onDeleted }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<WritingVoiceUser[]>([]);
  const [chats, setChats] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void window.electronAPI.writingVoices.users(voice.id).then((result) => {
      if (live && 'agents' in result) {
        setUsers(result.agents);
        setChats(result.chats ?? 0);
      }
    });
    return () => {
      live = false;
    };
  }, [open, voice.id]);
  const line = usersLine(users);
  const chatsLine =
    chats === 1
      ? "1 chat that kept this voice goes back to its agent's voice."
      : chats > 1
        ? `${chats} chats that kept this voice go back to their agents' voices.`
        : null;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.writingVoices.delete(voice.id);
      if ('error' in result) setError(result.error);
      else {
        onClose();
        onDeleted(voice.id);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      busy={busy}
      titleId={`wb-voice-delete-${voice.id}`}
      title={`Delete ${voice.name}?`}
      error={error}
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onClose}
          confirmLabel="Delete voice"
          tone="danger"
          onConfirm={() => void confirm()}
        />
      }
    >
      {line ? <p className="wb-sheet-lede">{line}</p> : null}
      {chatsLine ? <p className="wb-sheet-lede">{chatsLine}</p> : null}
      <p className="wb-sheet-lede">
        The voice's folder, with its {voice.pieces} samples and style guide, moves to the Trash.
      </p>
    </Sheet>
  );
};
