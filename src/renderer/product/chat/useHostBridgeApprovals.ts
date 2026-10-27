import { useCallback, useEffect, useState } from 'react';
import type {
  HostBridgeApprovalChoice,
  HostBridgeApprovalEvent,
} from '../../../shared/types/hostBridge';

/**
 * Host-bridge approvals waiting on the user (ADR 0027 §7), oldest first. Picks up any that were
 * raised before this view mounted, and drops one when main settles it (answered elsewhere, or
 * denied on timeout).
 */
export function useHostBridgeApprovals() {
  const [approvals, setApprovals] = useState<HostBridgeApprovalEvent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Cleared while the pending list is in flight: the list may still carry them.
    const cleared = new Set<string>();
    const add = (event: HostBridgeApprovalEvent) =>
      setApprovals((prev) => (prev.some((item) => item.id === event.id) ? prev : [...prev, event]));
    const unsubApproval = window.electronAPI.hostBridge.onApproval(add);
    const unsubCleared = window.electronAPI.hostBridge.onApprovalCleared(({ id }) => {
      cleared.add(id);
      setApprovals((prev) => prev.filter((item) => item.id !== id));
    });
    void window.electronAPI.hostBridge
      .listPendingApprovals()
      .then((pending) => {
        if (!cancelled) pending.filter((item) => !cleared.has(item.id)).forEach(add);
      })
      .catch(() => {
        /* best effort: live approvals still arrive */
      });
    return () => {
      cancelled = true;
      unsubApproval();
      unsubCleared();
    };
  }, []);

  const approval = approvals[0] ?? null;

  /** Answer the approval on screen. */
  const respond = useCallback(
    async (choice: HostBridgeApprovalChoice) => {
      if (!approval) return;
      const { id } = approval;
      setBusy(true);
      try {
        await window.electronAPI.hostBridge.respondApproval({ id, choice });
        // Settled or already gone: either way it leaves the queue.
        setApprovals((prev) => prev.filter((item) => item.id !== id));
      } finally {
        setBusy(false);
      }
    },
    [approval]
  );

  return { approval, queueSize: approvals.length, busy, respond };
}
