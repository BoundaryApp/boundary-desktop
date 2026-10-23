import { useCallback, useEffect, useState } from 'react';
import type {
  HostBridgeApprovalChoice,
  HostBridgeApprovalEvent,
} from '../../../shared/types/hostBridge';
import { hostBridgeIPC } from '../../services/hostBridgeIPCService';

function bridgeAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI?.hostBridge);
}

/**
 * Host-bridge approvals waiting on the user (ADR 0027 §7), oldest first. Picks up any that were
 * raised before this view mounted, and drops one when main settles it (answered elsewhere, or
 * denied on timeout).
 */
export function useHostBridgeApprovals() {
  const [approvals, setApprovals] = useState<HostBridgeApprovalEvent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridgeAvailable()) return;
    const add = (event: HostBridgeApprovalEvent) =>
      setApprovals((prev) => (prev.some((item) => item.id === event.id) ? prev : [...prev, event]));
    const unsubApproval = hostBridgeIPC.onApproval(add);
    const unsubCleared = hostBridgeIPC.onApprovalCleared(({ id }) =>
      setApprovals((prev) => prev.filter((item) => item.id !== id))
    );
    void hostBridgeIPC.listPendingApprovals().then((pending) => pending.forEach(add));
    return () => {
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
        await hostBridgeIPC.respondApproval({ id, choice });
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
