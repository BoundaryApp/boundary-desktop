import React, { useEffect, useState } from 'react';
import type { CircleChannel, CirclesResult } from '../../../../shared/types/circles';
import { Input } from '../../../components/ui/input';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';

/** Which channel sheet is open: adding one, renaming one, or removing one. */
export type ChannelSheet = { kind: 'add' } | { kind: 'rename'; channel: CircleChannel } | { kind: 'remove'; channel: CircleChannel };

const api = () => window.electronAPI.circles;

/**
 * An admin's channel sheets (Circle chats spec phase 5). Channels are Circle records, so a
 * change shows on members' Macs once it replicates. `onAdded` opens a new channel.
 */
export const ChannelSheets: React.FC<{
  circleKey: string;
  circleName: string;
  sheet: ChannelSheet | null;
  onClose: () => void;
  onAdded: (channelId: string) => void;
}> = ({ circleKey, circleName, sheet, onClose, onAdded }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(sheet?.kind === 'rename' ? sheet.channel.name : '');
    setError(null);
  }, [sheet]);

  const run = async <T extends object>(call: () => Promise<CirclesResult<T>>): Promise<CirclesResult<T> | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (result.success === false) {
        setError(result.error);
        return null;
      }
      return result;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!sheet || busy) return;
    if (sheet.kind === 'add') {
      const result = await run(() => api().chatAddChannel({ key: circleKey, name }));
      // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
      if (!result || result.success === false) return;
      onClose();
      onAdded(result.id);
    } else if (sheet.kind === 'rename') {
      if (await run(() => api().chatRenameChannel({ key: circleKey, channel: sheet.channel.id, name }))) onClose();
    } else if (await run(() => api().chatRemoveChannel({ key: circleKey, channel: sheet.channel.id }))) {
      onClose();
    }
  };

  if (sheet?.kind === 'remove') {
    return (
      <Sheet
        open
        onClose={onClose}
        busy={busy}
        titleId="circle-remove-channel"
        title={`Remove ${sheet.channel.name}?`}
        error={error}
        actions={
          <SheetConfirmActions
            busy={busy}
            tone="danger"
            confirmLabel={busy ? 'Removing…' : 'Remove'}
            onCancel={onClose}
            onConfirm={() => void submit()}
          />
        }
      >
        <p className="wb-sheet-help">
          It’s hidden for everyone in {circleName}. Its messages stay in the Circle’s history on every member’s Mac.
        </p>
      </Sheet>
    );
  }

  const adding = sheet?.kind === 'add';
  return (
    <Sheet
      open={sheet !== null}
      onClose={onClose}
      busy={busy}
      titleId="circle-channel-name"
      title={adding ? 'Add a channel' : 'Rename channel'}
      error={error}
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      actions={
        <>
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wb-btn-solid" disabled={busy || !name.trim()}>
            {adding ? (busy ? 'Adding…' : 'Add') : busy ? 'Renaming…' : 'Rename'}
          </button>
        </>
      }
    >
      <label htmlFor="circle-channel-name-input" className="wb-sheet-help">
        {adding ? `Everyone in ${circleName} can read it.` : 'Everyone sees the new name.'}
      </label>
      <Input
        id="circle-channel-name-input"
        className="h-[34px]"
        value={name}
        maxLength={80}
        autoFocus
        placeholder="Channel name"
        onChange={(event) => setName(event.target.value)}
      />
    </Sheet>
  );
};
