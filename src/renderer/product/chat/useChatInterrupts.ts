import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HermesApprovalChoice,
  HermesChatApprovalEvent,
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
} from '../../../shared/types/hermesChat';
import { isOwnedRunningTurn, useRunningTurns } from './runningTurns';
import { useHostBridgeApprovals } from './useHostBridgeApprovals';
import { useHostToolsState } from './useHostToolsState';
import { useCodingAccessRequests } from './useCodingAccessRequests';
import { useOnChatSwitch } from './useLiveTurn';

type SameChat = (a: string, b: string) => boolean;

/** After a login is saved from chat: where it went, with a way to manage it. */
export interface SavedLogin {
  site: string;
  agentSlug: string;
}

/**
 * What waits on the user above the composer: Hermes approvals and credential prompts, host
 * bridge approvals, coding-folder access, plus the saved-login note and the host-tools state.
 */
export function useChatInterrupts({
  sessionId,
  sameChat,
  speakerSlug,
}: {
  sessionId: string | null;
  sameChat?: SameChat;
  /** Whose logins a saved login lands in: the live speaker, else the chat's agent. */
  speakerSlug: string;
}) {
  const [approvals, setApprovals] = useState<HermesChatApprovalEvent[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  // Approvals answered or gone from main, so a pending list that was already in flight can't
  // bring them back.
  const settledApprovalsRef = useRef(new Set<string>());
  const ackedApprovalRef = useRef<string | null>(null);
  const [credentialRequests, setCredentialRequests] = useState<HermesChatCredentialRequestEvent[]>([]);
  const [savedLogin, setSavedLogin] = useState<SavedLogin | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const runningTurns = useRunningTurns();
  const hostApprovals = useHostBridgeApprovals();
  const hostTools = useHostToolsState();
  const codingAccess = useCodingAccessRequests(sessionId, sameChat);

  useEffect(() => {
    const unsubApproval = window.electronAPI.hermesChat.onChatApproval((event) => {
      setApprovals((prev) => withApproval(prev, event));
    });
    const unsubCredential = window.electronAPI.hermesChat.onChatCredentialRequest((event) => {
      setCredentialRequests((prev) =>
        prev.some((item) => item.rpcRequestId === event.rpcRequestId)
          ? prev.map((item) => (item.rpcRequestId === event.rpcRequestId ? event : item))
          : [...prev, event]
      );
    });
    return () => {
      unsubApproval();
      unsubCredential();
    };
  }, []);

  useOnChatSwitch(sessionId, sameChat, () => setCredentialError(null));

  // An approval blocks the agent until answered, so main keeps it parked: each mount or switch
  // shows the open chat's, which a reloaded or reopened window would otherwise never see.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void window.electronAPI.hermesChat
      .listPendingApprovals(sessionId)
      .then((pending) => {
        if (cancelled) return;
        const settled = settledApprovalsRef.current;
        setApprovals((prev) =>
          pending.filter((item) => !settled.has(item.rpcRequestId)).reduce(withApproval, prev)
        );
      })
      .catch(() => {
        /* best effort: live events still arrive */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // A credential prompt blocks the agent until answered, so it outlives a chat switch:
  // main keeps it parked, and each mount or switch shows whatever is still waiting.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.hermesChat
      .listPendingCredentialRequests()
      .then((pending) => {
        if (!cancelled) setCredentialRequests(pending);
      })
      .catch(() => {
        /* best effort: live events still arrive */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Approvals reach every window for every chat; keep them all (the chat waits on its answer)
  // and show only the open chat's. A new chat has no id yet, so it takes its own turn's.
  const chatApprovals = approvals.filter((item) => {
    const same = sameChat ?? ((a: string, b: string) => a === b);
    if (sessionId) return same(item.sessionId, sessionId);
    return runningTurns.some(
      (turn) =>
        isOwnedRunningTurn(turn.requestId) && turn.sessionIds.some((id) => same(id, item.sessionId))
    );
  });
  const approval = chatApprovals[0] ?? null;
  const credentialRequest = credentialRequests[0] ?? null;

  useEffect(() => {
    if (!approval) return;
    if (ackedApprovalRef.current === approval.rpcRequestId) return;
    ackedApprovalRef.current = approval.rpcRequestId;
    void window.electronAPI.hermesChat.ackApproval({
      sessionId: approval.sessionId,
      approvalRequestId: approval.approvalRequestId,
    });
  }, [approval]);

  useEffect(() => setApprovalError(null), [approval?.rpcRequestId]);

  const respondApproval = useCallback(
    async (choice: HermesApprovalChoice) => {
      if (!approval) return;
      const { rpcRequestId } = approval;
      setApprovalBusy(true);
      setApprovalError(null);
      try {
        const result = await window.electronAPI.hermesChat.respondApproval({ rpcRequestId, choice });
        // Main no longer holds it (answered elsewhere, withdrawn, or its socket dropped): drop the card.
        if (result.success || result.error?.startsWith('No pending')) {
          settledApprovalsRef.current.add(rpcRequestId);
          setApprovals((prev) => prev.filter((item) => item.rpcRequestId !== rpcRequestId));
        } else {
          setApprovalError(result.error ?? 'Could not send that answer. Try again.');
        }
      } finally {
        setApprovalBusy(false);
      }
    },
    [approval]
  );

  const respondCredential = useCallback(
    async (answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) => {
      if (!credentialRequest) return;
      const rpcRequestId = credentialRequest.rpcRequestId;
      setCredentialBusy(true);
      setCredentialError(null);
      try {
        const result = await window.electronAPI.hermesChat.respondCredentialRequest({ rpcRequestId, ...answer });
        if (result.success) {
          setCredentialRequests((prev) => prev.filter((item) => item.rpcRequestId !== rpcRequestId));
          if (credentialRequest.kind === 'vault.save_login' && answer.login) {
            setSavedLogin({
              site: credentialRequest.site ?? credentialRequest.origin ?? 'this site',
              agentSlug: speakerSlug,
            });
          }
        } else {
          setCredentialError(result.error ?? 'Could not send that. Try again.');
          // Main no longer holds it (answered elsewhere or timed out): drop the card.
          if (result.error?.startsWith('No pending')) {
            setCredentialRequests((prev) => prev.filter((item) => item.rpcRequestId !== rpcRequestId));
            setCredentialError(null);
          }
        }
      } finally {
        setCredentialBusy(false);
      }
    },
    [credentialRequest, speakerSlug]
  );

  useEffect(() => {
    setSavedLogin(null);
  }, [sessionId]);

  const dismissSavedLogin = useCallback(() => setSavedLogin(null), []);

  return {
    approval,
    chatApprovals,
    approvalBusy,
    approvalError,
    respondApproval,
    credentialRequest,
    credentialRequests,
    credentialBusy,
    credentialError,
    respondCredential,
    savedLogin,
    dismissSavedLogin,
    hostApprovals,
    hostTools,
    codingAccess,
  };
}

export type ChatInterrupts = ReturnType<typeof useChatInterrupts>;

/**
 * Add or update an approval. Hermes can deliver one approval twice (live, and replayed from its
 * queue under a `pending:` id); the later copy replaces the earlier, so it shows once.
 */
function withApproval(
  list: HermesChatApprovalEvent[],
  event: HermesChatApprovalEvent
): HermesChatApprovalEvent[] {
  const same = (item: HermesChatApprovalEvent) =>
    item.rpcRequestId === event.rpcRequestId ||
    (item.sessionId === event.sessionId && item.approvalRequestId === event.approvalRequestId);
  return list.some(same) ? list.map((item) => (same(item) ? event : item)) : [...list, event];
}
