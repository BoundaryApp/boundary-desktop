import { useCallback } from 'react';
import type {
  HostBridgeApprovalChoice,
  HostBridgeApprovalEvent,
} from '../../../shared/types/hostBridge';
import { usePendingQueue } from './usePendingQueue';

/**
 * Host-bridge approvals waiting on the user (ADR 0027 §7), oldest first. Picks up any that were
 * raised before this view mounted, and drops one when main settles it (answered elsewhere, or
 * denied on timeout).
 */
export function useHostBridgeApprovals() {
  const queue = usePendingQueue({
    subscribe: ({ add, clear }) => {
      const unsubApproval = window.electronAPI.hostBridge.onApproval(add);
      const unsubCleared = window.electronAPI.hostBridge.onApprovalCleared(({ id }) => clear(id));
      return () => {
        unsubApproval();
        unsubCleared();
      };
    },
    list: () => window.electronAPI.hostBridge.listPendingApprovals(),
    key: (item: HostBridgeApprovalEvent) => item.id,
    settle: (item: HostBridgeApprovalEvent, choice: HostBridgeApprovalChoice) =>
      window.electronAPI.hostBridge.respondApproval({ id: item.id, choice }),
    // Settled or already gone: either way it leaves the queue.
    isSettled: () => true,
  });

  const approval = queue.items[0] ?? null;
  const { respond: respondTo } = queue;

  /** Answer the approval on screen. */
  const respond = useCallback(
    async (choice: HostBridgeApprovalChoice) => {
      if (!approval) return;
      await respondTo(approval, choice);
    },
    [approval, respondTo]
  );

  return { approval, queueSize: queue.items.length, busy: queue.busy, respond };
}
