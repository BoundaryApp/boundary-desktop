import { handle, handleResult } from '../../../ipc';
import { listHermesMentions, markHermesMentionsSeen } from './hermesMentionIndex';
import {
  createHermesChat,
  openAgentDm,
  getHermesChatContextBreakdown,
  branchHermesChat,
  getHermesChatHistory,
  handleHermesChatCancel,
  listHermesChatThreads,
  startHermesChatStream,
} from './hermesChatSessions';
import { revealProjectFile, saveReplyToProject } from './hermesReplyFiles';
import {
  listConversationProjectMarks,
  moveConversationsToProject,
  undoProjectMove,
} from './hermesChatProjects';
import {
  clearSessionInferenceOverride,
  getSessionInferenceSnapshot,
  setSessionInferenceOverride,
} from './sessionInference';
import {
  handleHermesChatApprovalReceived,
  handleHermesChatApprovalRespond,
  listPendingApprovals,
} from './hermesApprovalIpc';
import { listParkedCredentialRequests, respondToCredentialRequest } from './hermesCredentialRequests';
import { listRunningTurns } from './hermesRunningTurns';
import type {
  HermesChatApprovalAckPayload,
  HermesChatApprovalRespondPayload,
  HermesChatCredentialRespondPayload,
  HermesChatCancelPayload,
  HermesChatBranchPayload,
  HermesRevealProjectFilePayload,
  HermesSaveReplyPayload,
  HermesChatHistoryPayload,
  HermesChatStartPayload,
  HermesSessionInferencePayload,
  HermesSessionInferenceSetPayload,
  HermesCreateHermesChatPayload,
  HermesMoveToProjectPayload,
  HermesUndoProjectMovePayload,
  HermesOpenAgentDmPayload,
} from '../../../../shared/types/hermesChat';

export function registerHermesChatHandlers(): void {
  handleResult('hermes-chat:list-threads', async () => listHermesChatThreads());

  handleResult(
    'hermes-chat:create-hermes-chat',
    async (_event, payload?: HermesCreateHermesChatPayload) => createHermesChat(payload)
  );

  handleResult(
    'hermes-chat:move-to-project',
    async (_event, payload: HermesMoveToProjectPayload) => moveConversationsToProject(payload)
  );

  handleResult(
    'hermes-chat:undo-project-move',
    async (_event, payload: HermesUndoProjectMovePayload) => undoProjectMove(payload)
  );

  handle(
    'hermes-chat:project-marks',
    async (_event, payload: { sessionId: string }) =>
      listConversationProjectMarks(payload.sessionId)
  );

  handleResult('hermes-chat:list-mentions', async () => listHermesMentions());

  handle('hermes-chat:mark-mentions-seen', async () => markHermesMentionsSeen());

  handle('hermes-chat:running-list', async () => listRunningTurns());

  handleResult(
    'hermes-chat:open-agent-dm',
    async (_event, payload: HermesOpenAgentDmPayload) => openAgentDm(payload)
  );

  handleResult(
    'hermes-chat:save-reply',
    async (event, payload: HermesSaveReplyPayload) => saveReplyToProject(event.sender, payload)
  );

  handleResult(
    'hermes-chat:reveal-project-file',
    async (_event, payload: HermesRevealProjectFilePayload) => revealProjectFile(payload)
  );

  handleResult(
    'hermes-chat:branch',
    async (_event, payload: HermesChatBranchPayload) => branchHermesChat(payload)
  );

  handleResult(
    'hermes-chat:get-history',
    async (_event, payload: HermesChatHistoryPayload) =>
      getHermesChatHistory(payload.sessionId)
  );

  handleResult(
    'hermes-chat:get-session-inference',
    async (_event, payload: HermesSessionInferencePayload) =>
      getSessionInferenceSnapshot(payload.sessionId)
  );

  handleResult(
    'hermes-chat:set-session-inference',
    async (_event, payload: HermesSessionInferenceSetPayload) =>
      setSessionInferenceOverride(payload)
  );

  handleResult(
    'hermes-chat:clear-session-inference',
    async (_event, payload: HermesSessionInferencePayload) =>
      clearSessionInferenceOverride(payload.sessionId)
  );

  handleResult(
    'hermes-chat:context-breakdown',
    async (_event, payload: HermesChatHistoryPayload) =>
      getHermesChatContextBreakdown(payload.sessionId)
  );

  handleResult(
    'hermes-chat:start',
    async (event, payload: HermesChatStartPayload) =>
      startHermesChatStream(event.sender, payload)
  );

  handle(
    'hermes-chat:cancel',
    async (_event, payload: HermesChatCancelPayload) => handleHermesChatCancel(payload)
  );

  handleResult(
    'hermes-chat:approval-respond',
    async (_event, payload: HermesChatApprovalRespondPayload) =>
      handleHermesChatApprovalRespond(payload)
  );

  // Carries a credential value: no logging here or downstream.
  handleResult(
    'hermes-chat:credential-respond',
    async (_event, payload: HermesChatCredentialRespondPayload) =>
      respondToCredentialRequest(payload)
  );

  // Requests still waiting on an answer, so a remounted thread can show them again.
  handle('hermes-chat:credential-pending', async () => listParkedCredentialRequests());

  // Approvals still waiting on an answer, keyed by chat, so a reopened window can answer them.
  handle('hermes-chat:approval-pending', async (_event, sessionId?: string) =>
    listPendingApprovals(sessionId)
  );

  handleResult(
    'hermes-chat:approval-received',
    async (_event, payload: HermesChatApprovalAckPayload) =>
      handleHermesChatApprovalReceived(payload)
  );
}
