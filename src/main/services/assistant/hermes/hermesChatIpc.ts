import {
  listHermesMentions,
  markHermesMentionsSeen,
  summarizeHermesMentions,
} from './hermesMentionIndex';
import { ipcMain } from 'electron';
import type { KanbanTaskAction } from '../../../../shared/types/hermesKanban';
import type {
  CodingCreateFolderPayload,
  CodingDeleteFolderPayload,
  CodingGrantPayload,
  CodingRemoveFolderPayload,
  CodingProjectFolderPayload,
  CodingRevokePayload,
} from '../../../../shared/types/codingFolders';
import {
  checkNewCodingFolder,
  codingFoldersBusy,
  createCodingFolder,
  grantCoding,
  inspectCodingFolder,
  listCodingGrants,
  newCodingFolderDefaults,
  pickCodingFolder,
  pickCodingParent,
  retryCodingMounts,
  verifyCodingGrants,
  restartHermesForCodingGrants,
  revokeCoding,
  setProjectFolderCoding,
} from '../coding/codingGrants';
import {
  deleteCodingFolder,
  inspectFolderForDelete,
  removeCodingFolder,
  showTrash,
} from '../coding/codingFolderActions';
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
  fileChannels,
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
} from './hermesApprovalIpc';
import {
  listParkedCredentialRequests,
  respondToCredentialRequest,
} from './hermesCredentialRequests';
import {
  changeHermesProjectFolder,
  completeHermesPath,
  createEmptyHermesProject,
  createHostFolderHermesProject,
  listHermesProjects,
  listHermesProjectTree,
  patchHermesProject,
  pickHermesProjectFolder,
  revealHermesProjectInFinder,
  selectHermesProject,
} from './hermesProjects';
import {
  addHermesProjectSourceFolder,
  countHermesProjectExtraSources,
  inspectHermesProjectSources,
  refreshHermesProjectIndex,
  removeHermesProjectSource,
  revealHermesProjectSource,
} from './hermesProjectSources';
import { listRunningTurns } from './hermesRunningTurns';
import {
  ensureKanbanFeed,
  getKanbanSnapshot,
  getKanbanTask,
  getKanbanTaskLog,
  kanbanBoardUrl,
  kanbanTaskAction,
} from './hermesKanban';
import { ensureOrchestratorAgent } from './hermesOrchestrator';
import {
  createHermesAgent,
  updateHermesAgent,
  getHermesAgentSoul,
  listHermesAgents,
  revealHermesAgentSoul,
} from './hermesAgents';
import {
  addHermesChannelMember,
  removeHermesChannelMember,
  renameHermesChannel,
  deleteHermesChannel,
  createHermesChannel,
  listHermesChannels,
  makeChannelFromHermesChat,
  setHermesLastOpened,
} from './hermesChannels';
import type {
  HermesAgentCreatePayload,
  HermesAgentUpdatePayload,
  HermesAgentSoulPayload,
  HermesChannelAddMemberPayload,
  HermesChannelRenamePayload,
  HermesChannelDeletePayload,
  HermesChannelCreatePayload,
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
  HermesCompletePathPayload,
  HermesProjectChangeFolderPayload,
  HermesProjectCreateEmptyPayload,
  HermesProjectCreateHostPayload,
  HermesProjectPatchPayload,
  HermesProjectSelectPayload,
  HermesProjectSourcesAddPayload,
  HermesProjectSourcesInspectPayload,
  HermesProjectSourcesRemovePayload,
  HermesProjectSourcesRevealPayload,
  HermesCreateHermesChatPayload,
  HermesMakeChannelFromChatPayload,
  HermesMentionsListPayload,
  HermesMoveToProjectPayload,
  HermesUndoProjectMovePayload,
  HermesOpenAgentDmPayload,
  HermesSetLastOpenedPayload,
} from '../../../../shared/types/hermesChat';

export function registerHermesChatHandlers(): void {
  ipcMain.handle('hermes-chat:list-threads', async () => listHermesChatThreads());

  ipcMain.handle(
    'hermes-chat:create-hermes-chat',
    async (_event, payload?: HermesCreateHermesChatPayload) => createHermesChat(payload)
  );

  ipcMain.handle(
    'hermes-chat:move-to-project',
    async (_event, payload: HermesMoveToProjectPayload) => moveConversationsToProject(payload)
  );

  ipcMain.handle(
    'hermes-chat:undo-project-move',
    async (_event, payload: HermesUndoProjectMovePayload) => undoProjectMove(payload)
  );

  ipcMain.handle(
    'hermes-chat:project-marks',
    async (_event, payload: { sessionId: string }) =>
      listConversationProjectMarks(payload.sessionId)
  );

  ipcMain.handle(
    'hermes-chat:list-mentions',
    async (_event, payload?: HermesMentionsListPayload) => listHermesMentions(payload)
  );

  ipcMain.handle('hermes-chat:mentions-summary', async () => summarizeHermesMentions());

  ipcMain.handle('hermes-chat:mark-mentions-seen', async () => markHermesMentionsSeen());

  ipcMain.handle('hermes-chat:running-list', async () => listRunningTurns());

  // Kanban tasks (docs/kanban-activity-ux-study). The first renderer to ask starts the feed.
  ipcMain.handle('hermes-kanban:snapshot', async () => {
    ensureKanbanFeed();
    return getKanbanSnapshot();
  });

  ipcMain.handle('hermes-kanban:task', async (_event, taskId: unknown) => getKanbanTask(taskId));

  ipcMain.handle('hermes-kanban:action', async (_event, taskId: unknown, action: unknown) =>
    kanbanTaskAction(taskId, action as KanbanTaskAction)
  );

  ipcMain.handle('hermes-kanban:open-board', async () => {
    const { shell } = await import('electron');
    await shell.openExternal(kanbanBoardUrl());
  });

  ipcMain.handle('hermes-kanban:task-log', async (_event, taskId: unknown, tailBytes: unknown) =>
    getKanbanTaskLog(taskId, tailBytes)
  );

  ipcMain.handle(
    'hermes-chat:open-agent-dm',
    async (_event, payload: HermesOpenAgentDmPayload) => openAgentDm(payload)
  );

  ipcMain.handle('hermes-agents:list', async () => {
    void ensureOrchestratorAgent();
    return listHermesAgents();
  });

  ipcMain.handle(
    'hermes-agents:create',
    async (_event, payload: HermesAgentCreatePayload) => createHermesAgent(payload)
  );

  ipcMain.handle(
    'hermes-agents:update',
    async (_event, payload: HermesAgentUpdatePayload) => updateHermesAgent(payload)
  );

  ipcMain.handle(
    'hermes-agents:soul',
    async (_event, payload: HermesAgentSoulPayload) => getHermesAgentSoul(payload)
  );

  ipcMain.handle(
    'hermes-agents:reveal-soul',
    async (_event, payload: HermesAgentSoulPayload) => revealHermesAgentSoul(payload)
  );

  ipcMain.handle('hermes-channels:list', async () => {
    const result = listHermesChannels();
    return result.success ? { ...result, channels: fileChannels(result.channels) } : result;
  });

  ipcMain.handle(
    'hermes-channels:create',
    async (_event, payload: HermesChannelCreatePayload) =>
      createHermesChannel(payload)
  );

  ipcMain.handle(
    'hermes-channels:add-member',
    async (_event, payload: HermesChannelAddMemberPayload) =>
      addHermesChannelMember(payload)
  );

  ipcMain.handle(
    'hermes-channels:remove-member',
    async (_event, payload: HermesChannelAddMemberPayload) =>
      removeHermesChannelMember(payload)
  );

  ipcMain.handle(
    'hermes-channels:rename',
    async (_event, payload: HermesChannelRenamePayload) => renameHermesChannel(payload)
  );

  ipcMain.handle('hermes-channels:delete', async (_event, payload: HermesChannelDeletePayload) =>
    deleteHermesChannel(payload)
  );


  ipcMain.handle(
    'hermes-channels:make-from-chat',
    async (_event, payload: HermesMakeChannelFromChatPayload) =>
      makeChannelFromHermesChat(payload)
  );

  ipcMain.handle(
    'hermes-channels:set-last-opened',
    async (_event, payload: HermesSetLastOpenedPayload) =>
      setHermesLastOpened(payload)
  );

  ipcMain.handle(
    'hermes-chat:save-reply',
    async (event, payload: HermesSaveReplyPayload) => saveReplyToProject(event.sender, payload)
  );

  ipcMain.handle(
    'hermes-chat:reveal-project-file',
    async (_event, payload: HermesRevealProjectFilePayload) => revealProjectFile(payload)
  );

  ipcMain.handle(
    'hermes-chat:branch',
    async (_event, payload: HermesChatBranchPayload) => branchHermesChat(payload)
  );

  ipcMain.handle(
    'hermes-chat:get-history',
    async (_event, payload: HermesChatHistoryPayload) =>
      getHermesChatHistory(payload.sessionId)
  );

  ipcMain.handle(
    'hermes-chat:get-session-inference',
    async (_event, payload: HermesSessionInferencePayload) =>
      getSessionInferenceSnapshot(payload.sessionId)
  );

  ipcMain.handle(
    'hermes-chat:set-session-inference',
    async (_event, payload: HermesSessionInferenceSetPayload) =>
      setSessionInferenceOverride(payload)
  );

  ipcMain.handle(
    'hermes-chat:clear-session-inference',
    async (_event, payload: HermesSessionInferencePayload) =>
      clearSessionInferenceOverride(payload.sessionId)
  );

  ipcMain.handle(
    'hermes-chat:context-breakdown',
    async (_event, payload: HermesChatHistoryPayload) =>
      getHermesChatContextBreakdown(payload.sessionId)
  );

  ipcMain.handle(
    'hermes-chat:start',
    async (event, payload: HermesChatStartPayload) =>
      startHermesChatStream(event.sender, payload)
  );

  ipcMain.handle(
    'hermes-chat:cancel',
    async (event, payload: HermesChatCancelPayload) =>
      handleHermesChatCancel(event.sender.id, payload)
  );

  ipcMain.handle(
    'hermes-chat:approval-respond',
    async (_event, payload: HermesChatApprovalRespondPayload) =>
      handleHermesChatApprovalRespond(payload)
  );

  // Carries a credential value: no logging here or downstream.
  ipcMain.handle(
    'hermes-chat:credential-respond',
    async (_event, payload: HermesChatCredentialRespondPayload) =>
      respondToCredentialRequest(payload)
  );

  // Requests still waiting on an answer, so a remounted thread can show them again.
  ipcMain.handle('hermes-chat:credential-pending', async () => listParkedCredentialRequests());

  ipcMain.handle(
    'hermes-chat:approval-received',
    async (_event, payload: HermesChatApprovalAckPayload) =>
      handleHermesChatApprovalReceived(payload)
  );

  ipcMain.handle('hermes-projects:list', async () => listHermesProjects());

  ipcMain.handle('hermes-projects:pick-folder', async () => pickHermesProjectFolder());

  ipcMain.handle(
    'hermes-projects:create-host',
    async (_event, payload: HermesProjectCreateHostPayload) =>
      createHostFolderHermesProject(payload)
  );

  ipcMain.handle(
    'hermes-projects:create-empty',
    async (_event, payload: HermesProjectCreateEmptyPayload) =>
      createEmptyHermesProject(payload)
  );

  ipcMain.handle(
    'hermes-projects:select',
    async (_event, payload: HermesProjectSelectPayload) => selectHermesProject(payload)
  );

  ipcMain.handle(
    'hermes-projects:change-folder',
    async (_event, payload: HermesProjectChangeFolderPayload) =>
      changeHermesProjectFolder(payload)
  );

  ipcMain.handle(
    'hermes-projects:patch',
    async (_event, payload: HermesProjectPatchPayload) => patchHermesProject(payload)
  );

  ipcMain.handle(
    'hermes-projects:reveal',
    async (_event, payload: { projectId: string }) =>
      revealHermesProjectInFinder(payload.projectId)
  );

  ipcMain.handle(
    'hermes-projects:tree',
    async (_event, payload: { projectId: string }) =>
      listHermesProjectTree(payload.projectId)
  );

  ipcMain.handle(
    'hermes-projects:complete-path',
    async (_event, payload: HermesCompletePathPayload) => completeHermesPath(payload)
  );

  ipcMain.handle(
    'hermes-projects:source-count',
    async (_event, payload: HermesProjectSourcesInspectPayload) =>
      countHermesProjectExtraSources(payload.projectId)
  );

  ipcMain.handle(
    'hermes-projects:sources-inspect',
    async (_event, payload: HermesProjectSourcesInspectPayload) =>
      inspectHermesProjectSources(payload.projectId)
  );

  ipcMain.handle(
    'hermes-projects:sources-add',
    async (_event, payload: HermesProjectSourcesAddPayload) =>
      addHermesProjectSourceFolder(payload.projectId, payload.hostPath)
  );

  ipcMain.handle(
    'hermes-projects:sources-remove',
    async (_event, payload: HermesProjectSourcesRemovePayload) =>
      removeHermesProjectSource(payload.projectId, payload.sourceId)
  );

  ipcMain.handle(
    'hermes-projects:sources-reveal',
    async (_event, payload: HermesProjectSourcesRevealPayload) =>
      revealHermesProjectSource(payload.projectId, payload.sourceId)
  );

  ipcMain.handle(
    'hermes-projects:sources-refresh',
    async (_event, payload: HermesProjectSourcesInspectPayload) =>
      refreshHermesProjectIndex(payload.projectId)
  );

  // Coding folders (ADR 0028).
  ipcMain.handle('coding-folders:list', async () => listCodingGrants());
  ipcMain.handle('coding-folders:busy', async () => codingFoldersBusy());
  ipcMain.handle('coding-folders:grant', async (_event, payload: CodingGrantPayload) =>
    grantCoding(payload)
  );
  ipcMain.handle(
    'coding-folders:project-folder',
    async (_event, payload: CodingProjectFolderPayload) => setProjectFolderCoding(payload)
  );
  ipcMain.handle('coding-folders:revoke', async (_event, payload: CodingRevokePayload) =>
    revokeCoding(payload)
  );
  ipcMain.handle(
    'coding-folders:create-folder',
    async (_event, payload: CodingCreateFolderPayload) => createCodingFolder(payload)
  );
  ipcMain.handle('coding-folders:restart-hermes', async () => restartHermesForCodingGrants());
  ipcMain.handle('coding-folders:retry', async () => retryCodingMounts());
  ipcMain.handle('coding-folders:pick', async () => pickCodingFolder());
  ipcMain.handle('coding-folders:verify', async (_event, payload?: { force?: boolean }) =>
    verifyCodingGrants(payload?.force)
  );
  ipcMain.handle(
    'coding-folders:remove',
    async (_event, payload: CodingRemoveFolderPayload) => removeCodingFolder(payload)
  );
  ipcMain.handle('coding-folders:inspect-delete', async (_event, payload: { hostPath: string }) =>
    inspectFolderForDelete(payload.hostPath)
  );
  ipcMain.handle(
    'coding-folders:delete',
    async (_event, payload: CodingDeleteFolderPayload) => deleteCodingFolder(payload)
  );
  ipcMain.handle('coding-folders:show-trash', async () => showTrash());
  ipcMain.handle('coding-folders:new-folder-defaults', async () => newCodingFolderDefaults());
  ipcMain.handle(
    'coding-folders:check-new-folder',
    async (_event, payload: { parent: string; name: string }) => checkNewCodingFolder(payload)
  );
  ipcMain.handle('coding-folders:pick-parent', async (_event, payload?: { defaultPath?: string }) =>
    pickCodingParent(payload?.defaultPath)
  );
  ipcMain.handle('coding-folders:inspect-folder', async (_event, payload: { hostPath: string }) =>
    inspectCodingFolder(payload.hostPath)
  );
}
