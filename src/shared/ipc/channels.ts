/**
 * Every IPC channel between main and the renderer, with its arguments and result.
 *
 * Main registers each invoke channel with `handle` or, when the result is an IpcResult,
 * `handleResult` (src/main/ipc.ts); both check the handler against this map. Preload exposes
 * each channel with `invoker` and subscribes to events with `listen` (src/preload.ts), so
 * `window.electronAPI` takes its types from here.
 */
import type { CircleRole, CircleSharing, CirclesResult, CirclesState } from '../types/circles';
import type { AppCommand } from '../appCommands';
import type { ThemePreference } from '../theme';
import type { IpcResult } from './result';
import type {
  RunningWorkItem,
  UpdateChannel,
  UpdateRestartResult,
  UpdateSnapshot,
} from '../types/updates';
import type {
  AssistantStackLifecycleSnapshot,
  AssistantStackStatus,
  EnsureAssistantStackResult,
} from '../types/assistantStack';
import type {
  CalendarAccessPayload,
  CalendarActionResult,
  CalendarConnectPayload,
  CalendarListResult,
  CalendarPrepareResult,
  CalendarProgressEvent,
  CalendarReplacePasswordPayload,
  CalendarSlugPayload,
  CalendarTestPayload,
  CalendarTestResult,
} from '../types/calendars';
import type {
  AcknowledgeCapabilityResult,
  CapabilityAssessment,
  CapabilityStatus,
} from '../types/capability';
import type {
  CodingAccessRequestEvent,
  CodingAgentBusy,
  CodingCreateFolderPayload,
  CodingCreateFolderResult,
  CodingDeleteFolderPayload,
  CodingDeleteFolderResult,
  CodingDeleteInspect,
  CodingFolderInspect,
  CodingFoldersResult,
  CodingGrantPayload,
  CodingNewFolderCheck,
  CodingNewFolderDefaults,
  CodingProjectFolderPayload,
  CodingRemoveFolderPayload,
  CodingRevokePayload,
} from '../types/codingFolders';
import type { ComposeInventorySnapshot } from '../types/composeInventory';
import type {
  HermesAgentCreatePayload,
  HermesAgentCreateResult,
  HermesAgentSoulPayload,
  HermesAgentSoulResult,
  HermesAgentsListResult,
  HermesAgentUpdatePayload,
  HermesAgentUpdateResult,
  HermesChannelAddMemberPayload,
  HermesChannelAddMemberResult,
  HermesChannelCreatePayload,
  HermesChannelCreateResult,
  HermesChannelDeletePayload,
  HermesChannelDeleteResult,
  HermesChannelRenamePayload,
  HermesChannelRenameResult,
  HermesChannelsListResult,
  HermesChatApprovalAckPayload,
  HermesChatApprovalEvent,
  HermesChatApprovalRespondPayload,
  HermesChatBranchPayload,
  HermesChatBranchResult,
  HermesChatBreakdownResult,
  HermesChatCancelPayload,
  HermesChatChunkEvent,
  HermesChatCreateThreadResult,
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
  HermesChatEndEvent,
  HermesChatErrorEvent,
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
  HermesCreateHermesChatPayload,
  HermesMakeChannelFromChatPayload,
  HermesMakeChannelFromChatResult,
  HermesMentionsListResult,
  HermesMoveToProjectPayload,
  HermesMoveToProjectResult,
  HermesOpenAgentDmPayload,
  HermesOpenAgentDmResult,
  HermesProjectChangeFolderPayload,
  HermesProjectCreateEmptyPayload,
  HermesProjectCreateHostPayload,
  HermesProjectPatchPayload,
  HermesProjectResult,
  HermesProjectSelectPayload,
  HermesProjectSourcesAddPayload,
  HermesProjectSourcesInspectPayload,
  HermesProjectSourcesRemovePayload,
  HermesProjectSourcesResult,
  HermesProjectSourcesRevealPayload,
  HermesProjectsListResult,
  HermesRevealProjectFilePayload,
  HermesRevealProjectFileResult,
  HermesRunningTurn,
  HermesSaveReplyPayload,
  HermesSaveReplyResult,
  HermesSessionInferencePayload,
  HermesSessionInferenceResult,
  HermesSessionInferenceSetPayload,
  HermesSetLastOpenedPayload,
  HermesSetLastOpenedResult,
  HermesUndoProjectMovePayload,
  SessionProjectMark,
} from '../types/hermesChat';
import type {
  KanbanBoardViewResult,
  KanbanSnapshot,
  KanbanTaskAction,
  KanbanTaskActionResult,
  KanbanTaskDetailResult,
  KanbanTaskLogResult,
} from '../types/hermesKanban';
import type {
  VaultActionResult,
  VaultAddLoginPayload,
  VaultListResult,
  VaultLockPayload,
  VaultRemovePayload,
  VaultReplacePasswordPayload,
  VaultSourcesResult,
  VaultUnlockPayload,
} from '../types/hermesVault';
import type {
  BoundaryBrowserState,
  BoundaryBrowserUpdateResult,
  HostBridgeApprovalEvent,
  HostBridgeApprovalRespondPayload,
  HostBridgeBrowserSettings,
  HostBridgeGrant,
  HostToolsState,
} from '../types/hostBridge';
import type { HostResourceSnapshot } from '../types/hostResources';
import type {
  AdoptLocalLlmInput,
  AdoptLocalLlmResult,
  CancelOAuthPkceResult,
  ClearLlmSlotInput,
  ClearOpenAiConfigResult,
  DiscoverLocalLlmsResult,
  InferenceProvidersStatus,
  ListConfiguredEndpointModelsInput,
  ListEndpointModelsInput,
  ListEndpointModelsResult,
  ListOAuthProvidersResult,
  LocalLlmChangedPayload,
  ProbeSlotHealthInput,
  ProbeSlotHealthResult,
  SaveLlmConnectionInput,
  SaveLlmConnectionResult,
  SendLlmTestMessageInput,
  SendLlmTestMessageResult,
  SetAppDefaultInput,
  SetAppDefaultResult,
  SetAppFallbacksInput,
  SetAppSharedModelInput,
  SetAppSharedModelResult,
  SetAppFallbacksResult,
  StartOAuthPkceInput,
  StartOAuthPkceResult,
  UpdateLlmModelInput,
  UpdateLlmModelResult,
} from '../types/onboarding';
import type {
  ApplyFirstRunFoldersResult,
  FirstRunFolder,
  OptionalSetupOutcome,
  PickFirstRunFoldersResult,
  SaveFirstRunFoldersResult,
  SetupProgress,
} from '../types/setupProgress';

/**
 * Renderer-to-main invoke channels: the arguments the renderer sends and what the main
 * handler resolves to. An interface, so private experiments can add channels by merging.
 */
export interface IpcInvokeChannels {
  'circles:get-state': () => CirclesState;
  /** Starts the network process if needed; the state comes back on `circles:state` too. */
  'circles:start': () => CirclesResult;
  'circles:set-display-name': (input: { name: string }) => CirclesResult;
  'circles:create': (input: { name: string }) => CirclesResult<{ key: string }>;
  /** Resolves once an online admin has admitted this device, or with the refusal. */
  'circles:join': (input: { code: string }) => CirclesResult<{ key: string }>;
  'circles:create-invite': (input: {
    key: string;
    expiresInMs?: number;
  }) => CirclesResult<{ invite: { id: string; code: string; expires: number } }>;
  'circles:revoke-invite': (input: { key: string; inviteId: string }) => CirclesResult;
  'circles:set-role': (input: { key: string; identity: string; role: CircleRole }) => CirclesResult;
  'circles:remove-member': (input: { key: string; identity: string }) => CirclesResult;
  'circles:leave': (input: { key: string }) => CirclesResult;
  /** What this user shares from their local model server, and with which Circles (ADR 0034). */
  'circles:set-sharing': (input: CircleSharing) => CirclesResult;
  /** Shows the Circles diagnostics file in Finder, for pulling it off a test machine. */
  'circles:reveal-diagnostics': () => IpcResult;
  /** What the user accepts from one provider (ADR 0034 §3); applies from the next send. */
  'circles:set-provider-settings': (input: { identity: string; private: boolean; trusted: boolean }) => CirclesResult;
  'appearance:get-theme': () => ThemePreference;
  'appearance:set-theme': (preference: ThemePreference) => IpcResult;
  'urls:open-url': (url: string) => IpcResult;

  'onboarding:get-status': () => InferenceProvidersStatus;
  'onboarding:clear-llm-slot': (input: ClearLlmSlotInput) => ClearOpenAiConfigResult;
  'onboarding:reconnect-saved-openrouter-key': () => SaveLlmConnectionResult;
  'onboarding:forget-saved-openrouter-key': () => ClearOpenAiConfigResult;
  'onboarding:set-app-default': (input: SetAppDefaultInput) => SetAppDefaultResult;
  'onboarding:set-app-fallbacks': (input: SetAppFallbacksInput) => SetAppFallbacksResult;
  'onboarding:set-app-shared-model': (input: SetAppSharedModelInput) => SetAppSharedModelResult;
  'onboarding:probe-slot-health': (input: ProbeSlotHealthInput) => ProbeSlotHealthResult;
  'onboarding:discover-local-llms': () => DiscoverLocalLlmsResult;
  'onboarding:adopt-local-llm': (input: AdoptLocalLlmInput) => AdoptLocalLlmResult;
  'onboarding:list-oauth-providers': () => ListOAuthProvidersResult;
  'onboarding:start-oauth-pkce': (input: StartOAuthPkceInput) => StartOAuthPkceResult;
  'onboarding:cancel-oauth-pkce': () => CancelOAuthPkceResult;
  'onboarding:list-endpoint-models': (input: ListEndpointModelsInput) => ListEndpointModelsResult;
  'onboarding:list-configured-endpoint-models': (
    input?: ListConfiguredEndpointModelsInput
  ) => ListEndpointModelsResult;
  'onboarding:save-llm-connection': (input: SaveLlmConnectionInput) => SaveLlmConnectionResult;
  'onboarding:update-llm-model': (input: UpdateLlmModelInput) => UpdateLlmModelResult;
  'onboarding:send-llm-test-message': (input: SendLlmTestMessageInput) => SendLlmTestMessageResult;

  'capability:assess': () => CapabilityAssessment;
  'capability:get-status': () => CapabilityStatus;
  'capability:acknowledge': () => AcknowledgeCapabilityResult;
  'capability:get-debug-log': () => { path: string; contents: string };

  'setup:get-progress': () => SetupProgress;
  'setup:record-outcome': (payload: { stepId: string; outcome: OptionalSetupOutcome }) => SetupProgress;
  'setup:pick-folders': () => PickFirstRunFoldersResult;
  'setup:save-folders': (payload: { folders: FirstRunFolder[] }) => SaveFirstRunFoldersResult;
  'setup:apply-folders': () => ApplyFirstRunFoldersResult;

  'assistant-stack:get-status': () => AssistantStackStatus;
  'assistant-stack:get-lifecycle': () => AssistantStackLifecycleSnapshot;
  'assistant-stack:ensure-running': () => EnsureAssistantStackResult;
  'assistant-stack:ensure-running-background': () => { started: boolean };
  'assistant-stack:ensure-and-apply-llm': () => EnsureAssistantStackResult;

  'updates:get-state': () => UpdateSnapshot;
  'updates:check': () => UpdateSnapshot;
  'updates:download': () => UpdateSnapshot;
  'updates:restart': (options: { force: boolean }) => UpdateRestartResult;
  'updates:restart-when-finished': (items: RunningWorkItem[]) => void;
  'updates:cancel-waiting': () => void;
  'updates:close-card': () => void;
  'updates:close-updated': () => void;
  'updates:skip-version': () => void;
  'updates:set-channel': (channel: UpdateChannel) => UpdateSnapshot;
  'updates:set-checks-enabled': (enabled: boolean) => UpdateSnapshot;
  'updates:set-feed-key': (key: string) => UpdateSnapshot;
  'updates:move-to-applications': () => void;

  'resources:get-snapshot': () => HostResourceSnapshot;
  'resources:get-compose-inventory': () => ComposeInventorySnapshot;
  'resources:subscribe-compose-inventory': () => { success: boolean };
  'resources:unsubscribe-compose-inventory': () => { success: boolean };

  'host-bridge:approval-respond': (
    payload: HostBridgeApprovalRespondPayload
  ) => IpcResult;
  'host-bridge:approvals-pending': () => HostBridgeApprovalEvent[];
  'host-bridge:tools-state': () => HostToolsState;
  'host-bridge:browser-state': () => BoundaryBrowserState;
  'host-bridge:browser-update': (settings: HostBridgeBrowserSettings) => BoundaryBrowserUpdateResult;
  'host-bridge:browser-open': () => IpcResult;
  'host-bridge:grants-list': () => HostBridgeGrant[];
  'host-bridge:grant-revoke': (grant: { capability: string; resource: string }) => HostBridgeGrant[];
  'host-bridge:grants-revoke-all': () => HostBridgeGrant[];
  /** Stop agent: no argument reads the state; `true` stops the host bridge, `false` restarts it. */
  'host-bridge:agent-stopped': (stopped?: boolean) => { stopped: boolean; error?: string; hermesError?: string };
  /** Replace both host bridge tokens, restart the bridge with them and re-provision Hermes. */
  'host-bridge:rotate-tokens': () => IpcResult;

  'calendars:list': () => CalendarListResult;
  'calendars:prepare': () => CalendarPrepareResult;
  /** Carries a password: never log it. */
  'calendars:test': (payload: CalendarTestPayload) => CalendarTestResult;
  /** Carries a password: never log it. */
  'calendars:connect': (payload: CalendarConnectPayload) => CalendarActionResult;
  'calendars:set-access': (payload: CalendarAccessPayload) => CalendarActionResult;
  'calendars:recheck': (payload: CalendarSlugPayload) => CalendarActionResult;
  'calendars:recheck-all': () => CalendarListResult;
  /** Carries a password: never log it. */
  'calendars:replace-password': (payload: CalendarReplacePasswordPayload) => CalendarActionResult;
  'calendars:remove': (payload: CalendarSlugPayload) => CalendarActionResult;

  'hermes-vault:list': (payload: { agentSlug: string }) => VaultListResult;
  'hermes-vault:sources': (payload: { agentSlug: string }) => VaultSourcesResult;
  /** Carries a password: never log it. */
  'hermes-vault:add-login': (payload: VaultAddLoginPayload) => VaultActionResult;
  /** Carries a password: never log it. */
  'hermes-vault:replace-password': (payload: VaultReplacePasswordPayload) => VaultActionResult;
  'hermes-vault:remove': (payload: VaultRemovePayload) => VaultActionResult;
  /** Carries a master password: never log it. */
  'hermes-vault:unlock': (payload: VaultUnlockPayload) => VaultActionResult;
  'hermes-vault:lock': (payload: VaultLockPayload) => VaultActionResult;

  'hermes-chat:list-threads': () => HermesChatListThreadsResult;
  'hermes-chat:create-hermes-chat': (
    payload?: HermesCreateHermesChatPayload
  ) => HermesChatCreateThreadResult;
  'hermes-chat:move-to-project': (payload: HermesMoveToProjectPayload) => HermesMoveToProjectResult;
  'hermes-chat:undo-project-move': (
    payload: HermesUndoProjectMovePayload
  ) => HermesMoveToProjectResult;
  'hermes-chat:project-marks': (payload: { sessionId: string }) => SessionProjectMark[];
  'hermes-chat:list-mentions': () => HermesMentionsListResult;
  'hermes-chat:mark-mentions-seen': () => { success: boolean };
  'hermes-chat:running-list': () => HermesRunningTurn[];
  'hermes-chat:open-agent-dm': (payload: HermesOpenAgentDmPayload) => HermesOpenAgentDmResult;
  'hermes-chat:branch': (payload: HermesChatBranchPayload) => HermesChatBranchResult;
  'hermes-chat:save-reply': (payload: HermesSaveReplyPayload) => HermesSaveReplyResult;
  'hermes-chat:reveal-project-file': (
    payload: HermesRevealProjectFilePayload
  ) => HermesRevealProjectFileResult;
  'hermes-chat:get-history': (payload: HermesChatHistoryPayload) => HermesChatHistoryResult;
  'hermes-chat:get-session-inference': (
    payload: HermesSessionInferencePayload
  ) => HermesSessionInferenceResult;
  'hermes-chat:set-session-inference': (
    payload: HermesSessionInferenceSetPayload
  ) => HermesSessionInferenceResult;
  'hermes-chat:clear-session-inference': (
    payload: HermesSessionInferencePayload
  ) => HermesSessionInferenceResult;
  'hermes-chat:context-breakdown': (payload: HermesChatHistoryPayload) => HermesChatBreakdownResult;
  'hermes-chat:start': (payload: HermesChatStartPayload) => HermesChatStartResult;
  'hermes-chat:cancel': (payload: HermesChatCancelPayload) => { success: boolean };
  'hermes-chat:approval-respond': (
    payload: HermesChatApprovalRespondPayload
  ) => IpcResult;
  'hermes-chat:approval-received': (
    payload: HermesChatApprovalAckPayload
  ) => IpcResult;
  /** Carries a credential value: never log it. */
  'hermes-chat:credential-respond': (
    payload: HermesChatCredentialRespondPayload
  ) => IpcResult;
  'hermes-chat:credential-pending': () => HermesChatCredentialRequestEvent[];
  'hermes-chat:approval-pending': (sessionId?: string) => HermesChatApprovalEvent[];

  'hermes-kanban:snapshot': () => KanbanSnapshot;
  'hermes-kanban:task': (taskId: string) => KanbanTaskDetailResult;
  'hermes-kanban:task-log': (taskId: string, tailBytes?: number) => KanbanTaskLogResult;
  'hermes-kanban:open-board': (taskId?: string) => void;
  'hermes-kanban:board-view': (taskId?: string) => KanbanBoardViewResult;
  'hermes-kanban:action': (taskId: string, action: KanbanTaskAction) => KanbanTaskActionResult;

  'hermes-agents:list': () => HermesAgentsListResult;
  'hermes-agents:create': (payload: HermesAgentCreatePayload) => HermesAgentCreateResult;
  'hermes-agents:update': (payload: HermesAgentUpdatePayload) => HermesAgentUpdateResult;
  'hermes-agents:soul': (payload: HermesAgentSoulPayload) => HermesAgentSoulResult;
  'hermes-agents:reveal-soul': (payload: HermesAgentSoulPayload) => IpcResult;

  'hermes-channels:list': () => HermesChannelsListResult;
  'hermes-channels:create': (payload: HermesChannelCreatePayload) => HermesChannelCreateResult;
  'hermes-channels:add-member': (
    payload: HermesChannelAddMemberPayload
  ) => HermesChannelAddMemberResult;
  'hermes-channels:remove-member': (
    payload: HermesChannelAddMemberPayload
  ) => HermesChannelAddMemberResult;
  'hermes-channels:rename': (payload: HermesChannelRenamePayload) => HermesChannelRenameResult;
  'hermes-channels:delete': (payload: HermesChannelDeletePayload) => HermesChannelDeleteResult;
  'hermes-channels:make-from-chat': (
    payload: HermesMakeChannelFromChatPayload
  ) => HermesMakeChannelFromChatResult;
  'hermes-channels:set-last-opened': (payload: HermesSetLastOpenedPayload) => HermesSetLastOpenedResult;

  'hermes-projects:list': () => HermesProjectsListResult;
  'hermes-projects:pick-folder': () => IpcResult<{ hostPath?: string; canceled?: boolean }>;
  'hermes-projects:create-host': (payload: HermesProjectCreateHostPayload) => HermesProjectResult;
  'hermes-projects:create-empty': (payload: HermesProjectCreateEmptyPayload) => HermesProjectResult;
  'hermes-projects:select': (payload: HermesProjectSelectPayload) => HermesProjectResult;
  'hermes-projects:change-folder': (payload: HermesProjectChangeFolderPayload) => HermesProjectResult;
  'hermes-projects:patch': (payload: HermesProjectPatchPayload) => HermesProjectResult;
  'hermes-projects:reveal': (payload: { projectId: string }) => IpcResult;
  'hermes-projects:complete-path': (payload: HermesCompletePathPayload) => HermesCompletePathResult;
  /** Extra source folders on a project, read from sources.yaml without a full inspect. */
  'hermes-projects:source-count': (payload: { projectId: string }) => number | null;
  'hermes-projects:sources-inspect': (
    payload: HermesProjectSourcesInspectPayload
  ) => HermesProjectSourcesResult;
  'hermes-projects:sources-add': (payload: HermesProjectSourcesAddPayload) => HermesProjectSourcesResult;
  'hermes-projects:sources-remove': (
    payload: HermesProjectSourcesRemovePayload
  ) => HermesProjectSourcesResult;
  'hermes-projects:sources-reveal': (
    payload: HermesProjectSourcesRevealPayload
  ) => IpcResult;
  'hermes-projects:sources-refresh': (
    payload: HermesProjectSourcesInspectPayload
  ) => HermesProjectSourcesResult;

  'coding-folders:list': () => CodingFoldersResult;
  'coding-folders:busy': () => CodingAgentBusy;
  'coding-folders:grant': (payload: CodingGrantPayload) => CodingFoldersResult;
  'coding-folders:project-folder': (payload: CodingProjectFolderPayload) => CodingFoldersResult;
  'coding-folders:revoke': (payload: CodingRevokePayload) => CodingFoldersResult;
  'coding-folders:create-folder': (payload: CodingCreateFolderPayload) => CodingCreateFolderResult;
  'coding-folders:restart-hermes': () => CodingFoldersResult;
  'coding-folders:retry': () => CodingFoldersResult;
  'coding-folders:pick': () => CodingFolderInspect;
  'coding-folders:verify': (payload?: { force?: boolean }) => CodingFoldersResult;
  'coding-folders:remove': (payload: CodingRemoveFolderPayload) => CodingFoldersResult;
  'coding-folders:inspect-delete': (payload: { hostPath: string }) => CodingDeleteInspect;
  'coding-folders:delete': (payload: CodingDeleteFolderPayload) => CodingDeleteFolderResult;
  'coding-folders:show-trash': () => void;
  'coding-folders:new-folder-defaults': () => CodingNewFolderDefaults;
  'coding-folders:check-new-folder': (payload: { parent: string; name: string }) => CodingNewFolderCheck;
  'coding-folders:pick-parent': (payload?: { defaultPath?: string }) => IpcResult<{ canceled?: boolean; hostPath?: string }>;
  'coding-folders:inspect-folder': (payload: { hostPath: string }) => CodingFolderInspect;
}

/**
 * Main-to-renderer event channels and the payload each one carries. Main sends them with
 * `sendEvent` or `broadcast`, which check the payload against this map.
 */
export interface IpcEventChannels {
  'circles:state': CirclesState;
  'app:menu-command': AppCommand;
  'local-llm:changed': LocalLlmChangedPayload;
  'capability:progress': string;
  'assistant-stack:lifecycle': AssistantStackLifecycleSnapshot;
  /** The stack's health check passed or stopped passing. */
  'assistant-stack:ready': boolean;
  /** A slot's health changed in main (a probe, or the local model appearing or going). */
  'onboarding:status': InferenceProvidersStatus;
  'resources:compose-inventory': ComposeInventorySnapshot;
  'updates:state': UpdateSnapshot;
  'updates:open': void;
  'updates:restart-requested': void;
  'host-bridge:approval': HostBridgeApprovalEvent;
  'host-bridge:approval-cleared': { id: string };
  'host-bridge:tools-state': HostToolsState;
  'calendars:changed': void;
  'calendars:progress': CalendarProgressEvent;
  'hermes-chat:running': HermesRunningTurn[];
  'hermes-chat:chunk': HermesChatChunkEvent;
  'hermes-chat:end': HermesChatEndEvent;
  'hermes-chat:error': HermesChatErrorEvent;
  'hermes-chat:phase': HermesChatPhaseEvent;
  'hermes-chat:speaker': HermesChatSpeakerEvent;
  'hermes-chat:tool': HermesChatToolEvent;
  'hermes-chat:approval': HermesChatApprovalEvent;
  'hermes-chat:credential-request': HermesChatCredentialRequestEvent;
  'hermes-chat:turn-stats': HermesChatTurnStats;
  'hermes-chat:sessions-changed': void;
  'hermes-kanban:snapshot': KanbanSnapshot;
  'hermes-kanban:open-task': string;
  'coding-folders:progress': string;
  'coding-folders:access-request': CodingAccessRequestEvent;
}

export type IpcChannel = keyof IpcInvokeChannels;
export type IpcArgs<C extends IpcChannel> = Parameters<IpcInvokeChannels[C]>;
export type IpcReturn<C extends IpcChannel> = ReturnType<IpcInvokeChannels[C]>;
export type IpcEventChannel = keyof IpcEventChannels;
