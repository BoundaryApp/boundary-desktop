import type {
  CodingAccessRequestEvent,
  CodingAgentBusy,
  CodingCreateFolderPayload,
  CodingCreateFolderResult,
  CodingDeleteFolderPayload,
  CodingDeleteFolderResult,
  CodingDeleteInspect,
  CodingRemoveFolderPayload,
  CodingFolderInspect,
  CodingFoldersResult,
  CodingGrantPayload,
  CodingNewFolderCheck,
  CodingNewFolderDefaults,
  CodingProjectFolderPayload,
  CodingRevokePayload,
} from '../../shared/types/codingFolders';
import type {
  KanbanBoardViewResult,
  KanbanSnapshot,
  KanbanTaskAction,
  KanbanTaskActionResult,
  KanbanTaskDetailResult,
  KanbanTaskLogResult,
} from '../../shared/types/hermesKanban';
import type {
  HermesAgentCreatePayload,
  HermesAgentCreateResult,
  HermesAgentUpdatePayload,
  HermesAgentUpdateResult,
  HermesAgentSoulPayload,
  HermesAgentSoulResult,
  HermesAgentsListResult,
  HermesChannelAddMemberPayload,
  HermesChannelAddMemberResult,
  HermesChannelRenamePayload,
  HermesChannelRenameResult,
  HermesChannelDeletePayload,
  HermesChannelDeleteResult,
  HermesChannelCreatePayload,
  HermesChannelCreateResult,
  HermesChannelsListResult,
  HermesChatApprovalAckPayload,
  HermesChatApprovalEvent,
  HermesChatApprovalRespondPayload,
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
  HermesChatBreakdownResult,
  HermesChatCancelPayload,
  HermesChatChunkEvent,
  HermesChatCreateThreadResult,
  HermesCreateHermesChatPayload,
  HermesMoveToProjectPayload,
  HermesMoveToProjectResult,
  HermesUndoProjectMovePayload,
  SessionProjectMark,
  HermesChatEndEvent,
  HermesChatErrorEvent,
  HermesChatBranchPayload,
  HermesChatBranchResult,
  HermesRevealProjectFilePayload,
  HermesRunningTurn,
  HermesRevealProjectFileResult,
  HermesSaveReplyPayload,
  HermesSaveReplyResult,
  HermesChatHistoryPayload,
  HermesChatHistoryResult,
  HermesChatListThreadsResult,
  HermesChatPhaseEvent,
  HermesChatSpeakerEvent,
  HermesChatStartPayload,
  HermesChatStartResult,
  HermesChatToolEvent,
  HermesChatTurnStats,
  HermesCompletePathPayload,
  HermesCompletePathResult,
  HermesProjectChangeFolderPayload,
  HermesProjectCreateEmptyPayload,
  HermesProjectCreateHostPayload,
  HermesProjectPatchPayload,
  HermesProjectResult,
  HermesProjectSelectPayload,
  HermesProjectSourcesAddPayload,
  HermesProjectSourcesInspectPayload,
  HermesProjectSourcesRemovePayload,
  HermesProjectSourcesRevealPayload,
  HermesProjectSourcesResult,
  HermesProjectsListResult,
  HermesProjectTreeResult,
  HermesMakeChannelFromChatPayload,
  HermesMentionsListPayload,
  HermesMentionsListResult,
  HermesMentionsSummaryResult,
  HermesMakeChannelFromChatResult,
  HermesOpenAgentDmPayload,
  HermesOpenAgentDmResult,
  HermesSetLastOpenedPayload,
  HermesSetLastOpenedResult,
} from '../../shared/types/hermesChat';

function api() {
  return window.electronAPI.hermesChat;
}

export const hermesChatIPC = {
  listThreads(): Promise<HermesChatListThreadsResult> {
    return api().listThreads();
  },

  createHermesChat(payload?: HermesCreateHermesChatPayload): Promise<HermesChatCreateThreadResult> {
    return api().createHermesChat(payload);
  },

  /** ADR 0024: the one way a conversation changes project. */
  moveToProject(payload: HermesMoveToProjectPayload): Promise<HermesMoveToProjectResult> {
    return api().moveToProject(payload);
  },

  undoProjectMove(payload: HermesUndoProjectMovePayload): Promise<HermesMoveToProjectResult> {
    return api().undoProjectMove(payload);
  },

  listProjectMarks(sessionId: string): Promise<SessionProjectMark[]> {
    return api().listProjectMarks({ sessionId });
  },

  listMentions(payload?: HermesMentionsListPayload): Promise<HermesMentionsListResult> {
    return api().listMentions(payload);
  },

  mentionsSummary(): Promise<HermesMentionsSummaryResult> {
    return api().mentionsSummary();
  },

  markMentionsSeen(): Promise<{ success: boolean }> {
    return api().markMentionsSeen();
  },

  listRunningTurns(): Promise<HermesRunningTurn[]> {
    return api().listRunningTurns();
  },

  onRunningTurns(callback: (turns: HermesRunningTurn[]) => void): () => void {
    return api().onRunningTurns(callback);
  },

  kanbanSnapshot(): Promise<KanbanSnapshot> {
    return api().kanbanSnapshot();
  },

  onKanbanSnapshot(callback: (snapshot: KanbanSnapshot) => void): () => void {
    return api().onKanbanSnapshot(callback);
  },

  kanbanTask(taskId: string): Promise<KanbanTaskDetailResult> {
    return api().kanbanTask(taskId);
  },

  kanbanTaskLog(taskId: string, tailBytes?: number): Promise<KanbanTaskLogResult> {
    return api().kanbanTaskLog(taskId, tailBytes);
  },

  /** The board, or one task on it, in the system browser. */
  openKanbanBoard(taskId?: string): Promise<void> {
    return api().openKanbanBoard(taskId);
  },

  /** The signed-in board URL for the Tasks pane's board view. */
  kanbanBoardView(taskId?: string): Promise<KanbanBoardViewResult> {
    return api().kanbanBoardView(taskId);
  },

  kanbanTaskAction(taskId: string, action: KanbanTaskAction): Promise<KanbanTaskActionResult> {
    return api().kanbanTaskAction(taskId, action);
  },

  onKanbanOpenTask(callback: (taskId: string) => void): () => void {
    return api().onKanbanOpenTask(callback);
  },

  openAgentDm(payload: HermesOpenAgentDmPayload): Promise<HermesOpenAgentDmResult> {
    return api().openAgentDm(payload);
  },

  listAgents(): Promise<HermesAgentsListResult> {
    return api().listAgents();
  },

  createAgent(payload: HermesAgentCreatePayload): Promise<HermesAgentCreateResult> {
    return api().createAgent(payload);
  },

  updateAgent(payload: HermesAgentUpdatePayload): Promise<HermesAgentUpdateResult> {
    return api().updateAgent(payload);
  },

  getAgentSoul(payload: HermesAgentSoulPayload): Promise<HermesAgentSoulResult> {
    return api().getAgentSoul(payload);
  },

  revealAgentSoul(payload: HermesAgentSoulPayload): Promise<{
    success: boolean;
    error?: string;
  }> {
    return api().revealAgentSoul(payload);
  },

  listChannels(): Promise<HermesChannelsListResult> {
    return api().listChannels();
  },

  createChannel(payload: HermesChannelCreatePayload): Promise<HermesChannelCreateResult> {
    return api().createChannel(payload);
  },

  addChannelMember(
    payload: HermesChannelAddMemberPayload
  ): Promise<HermesChannelAddMemberResult> {
    return api().addChannelMember(payload);
  },

  removeChannelMember(
    payload: HermesChannelAddMemberPayload
  ): Promise<HermesChannelAddMemberResult> {
    return api().removeChannelMember(payload);
  },

  renameChannel(payload: HermesChannelRenamePayload): Promise<HermesChannelRenameResult> {
    return api().renameChannel(payload);
  },

  deleteChannel(payload: HermesChannelDeletePayload): Promise<HermesChannelDeleteResult> {
    return api().deleteChannel(payload);
  },

  makeChannelFromHermesChat(
    payload: HermesMakeChannelFromChatPayload
  ): Promise<HermesMakeChannelFromChatResult> {
    return api().makeChannelFromHermesChat(payload);
  },

  setLastOpened(payload: HermesSetLastOpenedPayload): Promise<HermesSetLastOpenedResult> {
    return api().setLastOpened(payload);
  },

  branchChat(payload: HermesChatBranchPayload): Promise<HermesChatBranchResult> {
    return api().branchChat(payload);
  },

  saveReply(payload: HermesSaveReplyPayload): Promise<HermesSaveReplyResult> {
    return api().saveReply(payload);
  },

  revealProjectFile(
    payload: HermesRevealProjectFilePayload
  ): Promise<HermesRevealProjectFileResult> {
    return api().revealProjectFile(payload);
  },

  getHistory(payload: HermesChatHistoryPayload): Promise<HermesChatHistoryResult> {
    return api().getHistory(payload);
  },

  getSessionInference(
    payload: import('../../shared/types/hermesChat').HermesSessionInferencePayload
  ): Promise<import('../../shared/types/hermesChat').HermesSessionInferenceResult> {
    return api().getSessionInference(payload);
  },

  setSessionInference(
    payload: import('../../shared/types/hermesChat').HermesSessionInferenceSetPayload
  ): Promise<import('../../shared/types/hermesChat').HermesSessionInferenceResult> {
    return api().setSessionInference(payload);
  },

  clearSessionInference(
    payload: import('../../shared/types/hermesChat').HermesSessionInferencePayload
  ): Promise<import('../../shared/types/hermesChat').HermesSessionInferenceResult> {
    return api().clearSessionInference(payload);
  },

  getContextBreakdown(
    payload: HermesChatHistoryPayload
  ): Promise<HermesChatBreakdownResult> {
    return api().getContextBreakdown(payload);
  },

  startChat(payload: HermesChatStartPayload): Promise<HermesChatStartResult> {
    return api().startChat(payload);
  },

  cancelChat(payload: HermesChatCancelPayload): Promise<{ success: boolean }> {
    return api().cancelChat(payload);
  },

  onChatChunk(callback: (event: HermesChatChunkEvent) => void): () => void {
    return api().onChatChunk(callback);
  },

  onChatEnd(callback: (event: HermesChatEndEvent) => void): () => void {
    return api().onChatEnd(callback);
  },

  onChatError(callback: (event: HermesChatErrorEvent) => void): () => void {
    return api().onChatError(callback);
  },

  onChatPhase(callback: (event: HermesChatPhaseEvent) => void): () => void {
    return api().onChatPhase(callback);
  },

  onChatSpeaker(callback: (event: HermesChatSpeakerEvent) => void): () => void {
    return api().onChatSpeaker(callback);
  },

  onChatTool(callback: (event: HermesChatToolEvent) => void): () => void {
    return api().onChatTool(callback);
  },

  onChatApproval(callback: (event: HermesChatApprovalEvent) => void): () => void {
    return api().onChatApproval(callback);
  },

  onChatCredentialRequest(
    callback: (event: HermesChatCredentialRequestEvent) => void
  ): () => void {
    return api().onChatCredentialRequest(callback);
  },

  onChatTurnStats(callback: (event: HermesChatTurnStats) => void): () => void {
    return api().onChatTurnStats(callback);
  },

  onSessionsChanged(callback: () => void): () => void {
    return api().onSessionsChanged(callback);
  },

  respondApproval(
    payload: HermesChatApprovalRespondPayload
  ): Promise<{ success: boolean; error?: string }> {
    return api().respondApproval(payload);
  },

  ackApproval(
    payload: HermesChatApprovalAckPayload
  ): Promise<{ success: boolean; error?: string }> {
    return api().ackApproval(payload);
  },

  respondCredentialRequest(
    payload: HermesChatCredentialRespondPayload
  ): Promise<{ success: boolean; error?: string }> {
    return api().respondCredentialRequest(payload);
  },

  listPendingCredentialRequests(): Promise<HermesChatCredentialRequestEvent[]> {
    return api().listPendingCredentialRequests();
  },

  listProjects(): Promise<HermesProjectsListResult> {
    return api().listProjects();
  },

  pickFolder(): Promise<{
    success: boolean;
    hostPath?: string;
    canceled?: boolean;
    error?: string;
  }> {
    return api().pickFolder();
  },

  createHostProject(
    payload: HermesProjectCreateHostPayload
  ): Promise<HermesProjectResult> {
    return api().createHostProject(payload);
  },

  createEmptyProject(
    payload: HermesProjectCreateEmptyPayload
  ): Promise<HermesProjectResult> {
    return api().createEmptyProject(payload);
  },

  selectProject(payload: HermesProjectSelectPayload): Promise<HermesProjectResult> {
    return api().selectProject(payload);
  },

  changeFolder(payload: HermesProjectChangeFolderPayload): Promise<HermesProjectResult> {
    return api().changeFolder(payload);
  },

  patchProject(payload: HermesProjectPatchPayload): Promise<HermesProjectResult> {
    return api().patchProject(payload);
  },

  revealInFinder(payload: { projectId: string }): Promise<{
    success: boolean;
    error?: string;
  }> {
    return api().revealInFinder(payload);
  },

  listProjectTree(payload: { projectId: string }): Promise<HermesProjectTreeResult> {
    return api().listProjectTree(payload);
  },

  completePath(payload: HermesCompletePathPayload): Promise<HermesCompletePathResult> {
    return api().completePath(payload);
  },

  /** Extra source folders on a project, read cheaply from sources.yaml (Move sheet). */
  countProjectSources(projectId: string): Promise<number | null> {
    return api().countProjectSources({ projectId });
  },

  inspectSources(
    payload: HermesProjectSourcesInspectPayload
  ): Promise<HermesProjectSourcesResult> {
    return api().inspectSources(payload);
  },

  addSourceFolder(
    payload: HermesProjectSourcesAddPayload
  ): Promise<HermesProjectSourcesResult> {
    return api().addSourceFolder(payload);
  },

  removeSource(
    payload: HermesProjectSourcesRemovePayload
  ): Promise<HermesProjectSourcesResult> {
    return api().removeSource(payload);
  },

  revealSource(
    payload: HermesProjectSourcesRevealPayload
  ): Promise<{ success: boolean; error?: string }> {
    return api().revealSource(payload);
  },

  refreshIndex(
    payload: HermesProjectSourcesInspectPayload
  ): Promise<HermesProjectSourcesResult> {
    return api().refreshIndex(payload);
  },

  listCodingFolders(): Promise<CodingFoldersResult> {
    return api().listCodingFolders();
  },

  codingAgentBusy(): Promise<CodingAgentBusy> {
    return api().codingAgentBusy();
  },

  grantCodingFolder(payload: CodingGrantPayload): Promise<CodingFoldersResult> {
    return api().grantCodingFolder(payload);
  },

  setProjectFolderCoding(payload: CodingProjectFolderPayload): Promise<CodingFoldersResult> {
    return api().setProjectFolderCoding(payload);
  },

  revokeCodingFolder(payload: CodingRevokePayload): Promise<CodingFoldersResult> {
    return api().revokeCodingFolder(payload);
  },

  createCodingFolder(payload: CodingCreateFolderPayload): Promise<CodingCreateFolderResult> {
    return api().createCodingFolder(payload);
  },

  restartHermesForCodingFolders(): Promise<CodingFoldersResult> {
    return api().restartHermesForCodingFolders();
  },

  retryCodingFolders(): Promise<CodingFoldersResult> {
    return api().retryCodingFolders();
  },

  pickCodingFolder(): Promise<CodingFolderInspect> {
    return api().pickCodingFolder();
  },

  verifyCodingFolders(force = false): Promise<CodingFoldersResult> {
    return api().verifyCodingFolders({ force });
  },

  removeCodingFolder(payload: CodingRemoveFolderPayload): Promise<CodingFoldersResult> {
    return api().removeCodingFolder(payload);
  },

  inspectFolderForDelete(hostPath: string): Promise<CodingDeleteInspect> {
    return api().inspectFolderForDelete({ hostPath });
  },

  deleteCodingFolder(payload: CodingDeleteFolderPayload): Promise<CodingDeleteFolderResult> {
    return api().deleteCodingFolder(payload);
  },

  showTrash(): Promise<void> {
    return api().showTrash();
  },

  newCodingFolderDefaults(): Promise<CodingNewFolderDefaults> {
    return api().newCodingFolderDefaults();
  },

  checkNewCodingFolder(parent: string, name: string): Promise<CodingNewFolderCheck> {
    return api().checkNewCodingFolder({ parent, name });
  },

  pickCodingParent(
    defaultPath?: string
  ): Promise<{ success: boolean; canceled?: boolean; hostPath?: string; error?: string }> {
    return api().pickCodingParent({ defaultPath });
  },

  inspectCodingFolder(hostPath: string): Promise<CodingFolderInspect> {
    return api().inspectCodingFolder({ hostPath });
  },

  onCodingFoldersProgress(callback: (message: string) => void): () => void {
    return api().onCodingFoldersProgress(callback);
  },

  onCodingAccessRequest(callback: (event: CodingAccessRequestEvent) => void): () => void {
    return api().onCodingAccessRequest(callback);
  },
};
