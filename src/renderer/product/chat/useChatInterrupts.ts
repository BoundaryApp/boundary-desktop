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
import { useOnChatSwitch } from './useOnChatSwitch';
import { leftMain, usePendingQueue } from './usePendingQueue';

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
  knownProjectIds,
}: {
  sessionId: string | null;
  sameChat?: SameChat;
  /** Whose logins a saved login lands in: the live speaker, else the chat's agent. */
  speakerSlug: string;
  /** The listed projects' ids; a coding-access request for one that's gone is dropped. */
  knownProjectIds?: ReadonlySet<string>;
}) {
  const approvalQueue = usePendingQueue({
    subscribe: ({ add }) => window.electronAPI.hermesChat.onChatApproval(add),
    // An approval blocks the agent until answered, so main keeps it parked: each mount or switch
    // shows the open chat's, which a reloaded or reopened window would otherwise never see.
    list: sessionId ? () => window.electronAPI.hermesChat.listPendingApprovals(sessionId) : null,
    listKey: sessionId,
    key: (item: HermesChatApprovalEvent) => item.rpcRequestId,
    upsert: withApproval,
    settle: (item: HermesChatApprovalEvent, choice: HermesApprovalChoice) =>
      window.electronAPI.hermesChat.respondApproval({ rpcRequestId: item.rpcRequestId, choice }),
    // Main no longer holds it (answered elsewhere, withdrawn, or its socket dropped): drop the card.
    isSettled: leftMain,
    fallbackError: 'Could not send that answer. Try again.',
  });
  const approvals = approvalQueue.items;
  const ackedApprovalRef = useRef<string | null>(null);
  const credentialQueue = usePendingQueue({
    subscribe: ({ add }) => window.electronAPI.hermesChat.onChatCredentialRequest(add),
    // A credential prompt blocks the agent until answered, so it outlives a chat switch: main
    // keeps it parked, and each mount or switch shows whatever is still waiting. The list holds
    // every prompt, so one it leaves out has gone from main.
    list: () => window.electronAPI.hermesChat.listPendingCredentialRequests(),
    listKey: sessionId,
    listCovers: () => true,
    key: (item: HermesChatCredentialRequestEvent) => item.rpcRequestId,
    settle: (item: HermesChatCredentialRequestEvent, answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) =>
      window.electronAPI.hermesChat.respondCredentialRequest({ rpcRequestId: item.rpcRequestId, ...answer }),
    // Main no longer holds it (answered elsewhere or timed out): drop the card.
    isSettled: leftMain,
    fallbackError: 'Could not send that. Try again.',
  });
  const credentialRequests = credentialQueue.items;
  const [savedLogin, setSavedLogin] = useState<SavedLogin | null>(null);
  const runningTurns = useRunningTurns();
  const hostApprovals = useHostBridgeApprovals();
  const hostTools = useHostToolsState();
  const codingAccess = useCodingAccessRequests(sessionId, sameChat, knownProjectIds);


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

  const clearApprovalError = approvalQueue.clearError;
  useEffect(() => clearApprovalError(), [approval?.rpcRequestId, clearApprovalError]);

  const { respond: respondToApproval } = approvalQueue;
  const respondApproval = useCallback(
    async (choice: HermesApprovalChoice) => {
      if (!approval) return;
      await respondToApproval(approval, choice);
    },
    [approval, respondToApproval]
  );

  const { respond: respondToCredential } = credentialQueue;
  const respondCredential = useCallback(
    async (answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) => {
      if (!credentialRequest) return;
      const result = await respondToCredential(credentialRequest, answer);
      if (result.success && credentialRequest.kind === 'vault.save_login' && answer.login) {
        setSavedLogin({
          site: credentialRequest.site ?? credentialRequest.origin ?? 'this site',
          agentSlug: speakerSlug,
        });
      }
    },
    [credentialRequest, respondToCredential, speakerSlug]
  );

  // A new chat's first send adopting its id keeps the saved-login notice that send led to.
  useOnChatSwitch(sessionId, sameChat, () => {
    credentialQueue.clearError();
    setSavedLogin(null);
  });

  const dismissSavedLogin = useCallback(() => setSavedLogin(null), []);

  return {
    approval,
    chatApprovals,
    approvalBusy: approvalQueue.busy,
    approvalError: approvalQueue.error,
    respondApproval,
    credentialRequest,
    credentialRequests,
    credentialBusy: credentialQueue.busy,
    credentialError: credentialQueue.error,
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
