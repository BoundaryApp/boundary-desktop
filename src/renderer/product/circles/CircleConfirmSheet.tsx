import React from 'react';
import type { CircleMemberView, CircleSnapshot } from '../../../shared/types/circles';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { useAction } from './useCircles';

/** Leaving, deleting and removing someone each ask first, from the Circle tab and the Circles screen. */

const api = () => window.electronAPI.circles;

export type CircleConfirm = { kind: 'remove'; member: CircleMemberView } | { kind: 'leave' } | { kind: 'delete' };

function confirmCopy(pending: CircleConfirm | null, circle: CircleSnapshot, busy: boolean) {
  if (pending?.kind === 'delete') {
    return {
      title: `Delete ${circle.name}?`,
      label: busy ? 'Deleting…' : 'Delete Circle',
      help: 'You’re its only member, so this ends the Circle and its chats, and you can’t get it back. Anyone removed earlier keeps what they already received.',
    };
  }
  if (pending?.kind === 'leave') {
    return {
      title: `Leave ${circle.name}?`,
      label: busy ? 'Leaving…' : 'Leave',
      help: 'Its chats leave this Mac with it. Your messages stay in the Circle, and you’d need a new invite to come back. If no admin is online, the leave finishes the next time one is, while Boundary is open on this Mac.',
    };
  }
  return {
    title: `Remove ${pending?.member.name ?? ''} from ${circle.name}?`,
    label: busy ? 'Removing…' : 'Remove',
    help: 'They stop receiving anything new from this Circle. What they’ve already received stays with them.',
  };
}

export function CircleConfirmSheet({
  circle,
  pending,
  onClose,
}: {
  circle: CircleSnapshot;
  pending: CircleConfirm | null;
  onClose: () => void;
}) {
  const confirm = useAction();
  const copy = confirmCopy(pending, circle, confirm.busy);
  const run = async () => {
    if (!pending) return;
    const result = await confirm.run(() => {
      if (pending.kind === 'delete') return api().delete({ key: circle.key });
      if (pending.kind === 'leave') return api().leave({ key: circle.key });
      return api().removeMember({ key: circle.key, identity: pending.member.identity });
    });
    if (result?.success) onClose();
  };
  return (
    <Sheet
      open={pending !== null}
      onClose={() => {
        confirm.setError(null);
        onClose();
      }}
      busy={confirm.busy}
      titleId={`circle-confirm-${circle.key}`}
      title={copy.title}
      error={confirm.error}
      actions={
        <SheetConfirmActions
          busy={confirm.busy}
          onCancel={onClose}
          tone="danger"
          confirmLabel={copy.label}
          onConfirm={() => void run()}
        />
      }
    >
      <p className="wb-sheet-help">{copy.help}</p>
    </Sheet>
  );
}
