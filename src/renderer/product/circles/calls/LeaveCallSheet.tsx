import React, { useSyncExternalStore } from 'react';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import { getCallService } from './callService';
import { useCallNames } from './useCallNames';

/** Who this window's call is with, or null with no call or in a Circle's room. */
export function useCallWith(): string | null {
  const service = getCallService();
  return useSyncExternalStore(
    (listener) => service.onChange(listener),
    () => service.current?.with ?? null
  );
}

/**
 * Asks before **Call** or **Join** leaves the call this window is in, since only one call runs
 * at a time and leaving ends a call with one person for both sides.
 */
export const LeaveCallSheet: React.FC<{
  open: boolean;
  /** What happens after leaving: **Leave and call** or **Leave and join**. */
  then: 'call' | 'join';
  onLeave: () => void;
  onCancel: () => void;
}> = ({ open, then, onLeave, onCancel }) => {
  const names = useCallNames();
  const call = getCallService().current;
  const title = call?.with ? `Leave the call with ${names.person(call.circleKey, call.with)}?` : 'Leave the call?';
  return (
    <Sheet
      open={open}
      onClose={onCancel}
      titleId="leave-call-title"
      title={title}
      actions={
        <SheetConfirmActions
          onCancel={onCancel}
          confirmLabel={then === 'call' ? 'Leave and call' : 'Leave and join'}
          onConfirm={onLeave}
        />
      }
    >
      <p className="wb-sheet-help">You can be in one call at a time.</p>
    </Sheet>
  );
};
