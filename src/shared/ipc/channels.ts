/**
 * Every IPC channel between main and the renderer, with its arguments and result.
 *
 * Main registers each invoke channel with `handle` or, when the result is an IpcResult,
 * `handleResult` (src/main/ipc.ts); both check the handler against this map. Preload exposes
 * each channel with `invoker` and subscribes to events with `listen` (src/preload.ts), so
 * `window.electronAPI` takes its types from here.
 */
import type { RingAction, RingAlert } from '../calls/ringAlert';
import type { CallCheckResult, CallCheckSample, CallTunnelStats } from '../callCheck';
import type { InferenceStack } from '../types/inferenceChain';
import type { CallPart } from '../callSignalParts';
import type { CallLogInput } from '../calls/callLog';
import type { DesktopAgentSpot } from '../types/desktopAgent';
import type { CallState } from '../calls/callMessages';
import type { CallRingMessage } from '../calls/callRing';
import type {
  CircleChannel,
  CircleChatPresence,
  CirclePublicAddress,
  CircleChatUpdate,
  CircleCreatedInvite,
  CircleMessage,
  CircleMessageRef,
  CircleNotifyGlobal,
  CircleNotifyPrefs,
  CircleReadPosition,
  CircleRole,
  CircleSharing,
  CirclesResult,
  CirclesState,
  DirectConversation,
  DirectEvent,
  DirectMessage,
} from '../types/circles';
import type { AppCommand } from '../appCommands';
import type { StackHostCapabilities } from '../stackCapabilities';
import type { PoolSettings, TrustLevel } from '../types/confidential';
import type { AddProviderResult, ConfidentialSpend, ConfidentialState, PoolRanking } from '../types/confidentialState';
import type {
  DetectorCheckResult,
  DetectorProvider,
  DetectorStatus,
  WritingCheckFilePayload,
  WritingCheckFileResult,
  WritingCheckPickPayload,
} from '../types/writingCheck';
import type {
  FolderScan,
  ShareFolderInput,
  SharedFolderChange,
  SharedFolderConflict,
  SharedFolderFile,
  SharedFolderListing,
  SharedFolderOnMac,
  SharedFolderProblem,
  SharedFolderRole,
} from '../types/sharedFolders';
import type { ReportContext } from '../bugReport';
import type { WhatsNewSnapshot } from '../types/whatsNew';
import type { ChatHistoryExportStart, ChatHistoryState, ChatHistoryStatus } from '../types/chatHistory';
import type { ThemePreference } from '../theme';
import type { MediaAccess, MediaAccessStatus, MediaDevice } from '../types/media';
import type { IpcResult } from './result';
import type {
  ActualAccess,
  ActualBudgetsResult,
  ActualConnectInput,
  AddonInstallOptions,
  ActualConnectResult,
  ActualOverview,
  ActualScriptFailure,
  ActualServerInput,
  EmailAccountInput,
  EmailMailboxesResult,
  EmailOverview,
  EmailSettingsInput,
  AddonId,
  BitwardenConnectInput,
  BitwardenConnectResult,
  BitwardenOverview,
  BitwardenSyncResult,
  AddonInstallSnapshot,
  AddonListing,
  TwentyAccess,
  TwentyConnectInput,
  TwentyConnectResult,
  TwentyWorkspace,
} from '../types/addons';
import type { ServiceShareInput, SharedServicesView } from '../types/sharedServices';
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
  MacCalendarsPayload,
  MacConnectPayload,
  MacStatusResult,
} from '../types/calendars';
import type {
  AcknowledgeCapabilityResult,
  CapabilityAssessment,
  CapabilityStatus,
  RuntimeProvisionSnapshot,
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
import type { ProjectCreateProgressEvent } from '../types/projectCreate';
import type { ComposeInventorySnapshot } from '../types/composeInventory';
import type {
  HermesAgentCreatePayload,
  HermesAgentCreateResult,
  HermesAgentSoulPayload,
  AgentProfile,
  HermesSessionWritingVoice,
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
  HermesChatRespondResult,
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
  HermesProjectRemoveInspect,
  HermesProjectRemovePayload,
  HermesProjectRemoveResult,
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
  HermesHtmlPreviewPayload,
  HermesHtmlPreviewResult,
  HermesRevealProjectFilePayload,
  HermesRevealProjectFileResult,
  HermesRunningTurn,
  RepliesAtOnce,
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
import type { WebSearchMode, WebSearchModeState } from '../webSearchMode';
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
  AppSwitchEvent,
  InferenceStatusResult,
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
import type { AppBadge } from '../appBadge';
import type {
  WritingVoiceCheckSummary,
  WritingVoiceCreatePayload,
  WritingVoiceCreateResult,
  WritingVoiceListResult,
  WritingVoicePickResult,
  AgentWritingVoices,
  WritingVoiceActionResult,
  WritingVoiceProgress,
  WritingVoiceSamplesResult,
  WritingVoiceSource,
  WritingVoiceUsersResult,
  WritingVoiceViewResult,
} from '../types/writingVoices';

/**
 * Renderer-to-main invoke channels: the arguments the renderer sends and what the main
 * handler resolves to. An interface, so private experiments can add channels by merging.
 */
export interface IpcInvokeChannels {
  'confidential:get-state': () => ConfidentialState;
  /** The last 30 days of pool turns per provider; null while the pool is off. */
  'confidential:get-spend': () => ConfidentialSpend | null;
  /** Rejects when the service throws; a failed check comes back in the result, not as a rejection. */
  'confidential:add-provider': (args: { id: string; apiKey: string }) => AddProviderResult;
  'confidential:remove-provider': (args: { id: string }) => ConfidentialState;
  'confidential:set-settings': (args: PoolSettings) => ConfidentialState;
  'confidential:rank': (args: { modelId: string; privateProject: boolean; projectFloor?: TrustLevel }) => PoolRanking | null;
  'confidential:refresh': () => ConfidentialState;
  'addons:list': () => AddonListing[];
  /** `access` is the local workspace's setting, written before the restart step. */
  'addons:install': (id: AddonId, options?: AddonInstallOptions) => IpcResult;
  'addons:undo': (id: AddonId) => IpcResult;
  /** Stops the running install or removal; the snapshot says when it has. */
  'addons:cancel': (id: AddonId) => IpcResult;
  'addons:restart': (id: AddonId) => IpcResult;
  'addons:start': (id: AddonId) => IpcResult;
  'addons:turn-off': (id: AddonId) => IpcResult;
  'addons:remove': (id: AddonId, opts: { deleteImages: boolean }) => IpcResult;
  'addons:pending': () => string[];
  'addons:apply-pending': () => IpcResult;
  'addons:twenty-workspaces': () => TwentyWorkspace[];
  'addons:twenty-connect': (input: TwentyConnectInput) => IpcResult<{ result: TwentyConnectResult }>;
  'addons:twenty-disconnect': (slug: string) => IpcResult;
  'addons:twenty-access': (slug: string, access: TwentyAccess) => IpcResult;
  /** Opens the local Twenty in the browser, signed in as its owner when it can. The link stays in main. */
  'addons:twenty-open': () => IpcResult<{ warning?: string }>;
  /** Copies the owner password to the clipboard, which clears after 60 s. The password stays in main. */
  'addons:twenty-copy-password': () => IpcResult;
  /** Actual's connected budgets from the stack's index, with the last `status` states. */
  'addons:actual-overview': () => ActualOverview;
  /** Runs `budget.sh status --json`, then answers as `actual-overview`. */
  'addons:actual-refresh': () => ActualOverview;
  /** The budgets a password or session token opens. The credential goes to the script's stdin only. */
  'addons:actual-server-budgets': (input: ActualServerInput) => IpcResult<{ result: ActualBudgetsResult }>;
  'addons:actual-connect': (input: ActualConnectInput) => IpcResult<{ result: ActualConnectResult }>;
  'addons:actual-disconnect': (slug: string) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  'addons:actual-access': (
    slug: string,
    access: ActualAccess
  ) => IpcResult<{ result: { ok: true; mcp: string[] } | ActualScriptFailure }>;
  /** Opens a budget's server in the browser, or this Mac's server when `slug` is null. */
  'addons:actual-open': (slug: string | null) => IpcResult;
  /** Copies this Mac's server password to the clipboard, which clears after 60 s. It stays in main. */
  'addons:actual-copy-password': () => IpcResult;
  /** Opens Todo lists' signed-in web app at the `web.url` `addon.sh list --json` reports, while it's on. */
  'addons:vikunja-open': () => IpcResult;
  /** The account Todo lists' web app signs in as, while it's on; null before `init` or while off. Never the password. */
  'addons:vikunja-account': () => { username: string } | null;
  /** Copies that account's password to the clipboard, which clears after 60 s. It stays in main. */
  'addons:vikunja-copy-password': () => IpcResult;
  /** Bitwarden's accounts and requests as main last read them. */
  'addons:bitwarden-overview': () => BitwardenOverview;
  /** Runs `vault.sh status --json` and `requests --json`, then answers as `bitwarden-overview`. */
  'addons:bitwarden-refresh': () => BitwardenOverview;
  /** The API key and master password go to `addon.sh`'s stdin only; main keeps neither. */
  'addons:bitwarden-connect': (input: BitwardenConnectInput) => IpcResult<{ result: BitwardenConnectResult }>;
  'addons:bitwarden-disconnect': (slug: string) => IpcResult<{ result: { ok: true; message: string } | ActualScriptFailure }>;
  /** The master password goes to `vault.sh unlock`'s stdin only. */
  'addons:bitwarden-unlock': (slug: string, masterPassword: string) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  'addons:bitwarden-lock': (slug: string) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  /** `vault.sh sync --json`, then the requests again. */
  'addons:bitwarden-sync': () => IpcResult<{ result: BitwardenSyncResult }>;
  /** Email's accounts and indexer state as main last read them. */
  'addons:email-overview': () => EmailOverview;
  /** Re-reads `addon.sh list` and the indexer log, then answers as `email-overview`. */
  'addons:email-refresh': () => EmailOverview;
  /** The password goes to `addon.sh configure`'s stdin only; main keeps none. */
  'addons:email-save-account': (input: EmailAccountInput) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  'addons:email-mailboxes': (slug: string) => IpcResult<{ result: EmailMailboxesResult }>;
  'addons:email-set-mailboxes': (
    slug: string,
    mailboxes: string[]
  ) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  /** Cancel after a refused login: removes the account only if no mailboxes were ever saved. */
  'addons:email-cancel-account': (slug: string) => IpcResult;
  'addons:email-remove-account': (slug: string) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  'addons:email-settings': (input: EmailSettingsInput) => IpcResult<{ result: { ok: true } | ActualScriptFailure }>;
  'addons:running-work': () => RunningWorkItem[];
  /** The installer's current snapshot, so a reopened page shows a run in progress. */
  'addons:snapshot': () => AddonInstallSnapshot | null;
  'circles:get-state': () => CirclesState;
  /** Starts the network process if needed; the state comes back on `circles:state` too. */
  'circles:start': () => CirclesResult;
  'circles:set-display-name': (input: { name: string }) => CirclesResult;
  'circles:create': (input: { name: string }) => CirclesResult<{ key: string }>;
  /** Resolves once an online admin has admitted this device, or with the refusal. */
  'circles:join': (input: { code: string }) => CirclesResult<{ key: string }>;
  /** Stops a waiting join, or clears a failed one. */
  'circles:cancel-join': () => CirclesResult;
  'circles:create-invite': (input: {
    key: string;
    expiresInMs?: number;
    /** Kept on this device only. */
    label?: string;
  }) => CirclesResult<{ invite: CircleCreatedInvite }>;
  /** The start of each code this device keeps for a Circle, by invite id, for telling them apart. */
  'circles:invite-hints': (input: { key: string }) => CirclesResult<{ hints: Record<string, string> }>;
  /** A whole code, when the user asks to show or copy it. */
  'circles:invite-code': (input: { key: string; inviteId: string }) => CirclesResult<{ code: string }>;
  'circles:revoke-invite': (input: { key: string; inviteId: string }) => CirclesResult;
  'circles:set-role': (input: { key: string; identity: string; role: CircleRole }) => CirclesResult;
  'circles:remove-member': (input: { key: string; identity: string }) => CirclesResult;
  'circles:leave': (input: { key: string }) => CirclesResult;
  'circles:delete': (input: { key: string }) => CirclesResult;
  /** What this user shares from their local model server, and with which Circles (ADR 0034). */
  'circles:set-sharing': (input: CircleSharing) => CirclesResult;
  /** Shows the Circles diagnostics file in Finder, for pulling it off a test machine. */
  'circles:reveal-diagnostics': () => IpcResult;
  /** What the user accepts from one provider (ADR 0034 §3); applies from the next send. */
  'circles:set-provider-settings': (input: { identity: string; private: boolean; trusted: boolean }) => CirclesResult;
  /** A Circle's chat (ADR 0042). Changes arrive on `circles:chat-event`. */
  'circles:chat-channels': (input: { key: string }) => CirclesResult<{ channels: CircleChannel[] }>;
  'circles:chat-messages': (input: {
    key: string;
    channel: string;
    before?: CircleMessageRef;
    limit?: number;
  }) => CirclesResult<{ messages: CircleMessage[]; more: boolean }>;
  /** `shared` marks text shared from a Hermes chat (ADR 0042 §9); main checks its shape. */
  'circles:chat-post': (input: {
    key: string;
    channel: string;
    text: string;
    shared?: { role: 'user' | 'assistant'; model?: string };
    /** People picked from the @ list; main keeps those whose `@name` is still in the text. */
    picked?: { identity: string; name: string }[];
    /** `@channel` was picked; main keeps it when `@channel` is still in the text. */
    mentionChannel?: boolean;
    /** The message this one answers; refused below Circle format 3. */
    reply?: CircleMessageRef;
  }) => CirclesResult<{ id: string }>;
  /** One message by reference; `message` is null when this device's view doesn't hold it. */
  'circles:chat-message': (input: { key: string; channel: string; author: string; id: string }) => CirclesResult<{ message: CircleMessage | null }>;
  'circles:chat-edit': (input: {
    key: string;
    channel: string;
    id: string;
    text: string;
    picked?: { identity: string; name: string }[];
    mentionChannel?: boolean;
  }) => CirclesResult;
  'circles:chat-delete': (input: { key: string; channel: string; author: string; id: string }) => CirclesResult;
  'circles:chat-react': (input: { key: string; channel: string; author: string; id: string; emoji: string; on: boolean }) => CirclesResult;
  /** Keeps this device's read position and tells members online (a `chat.read` signal). */
  'circles:chat-read': (input: { key: string; channel: string; position: CircleReadPosition }) => CirclesResult;
  /** Admins add, rename and remove channels; they are `chat` records (ADR 0042 §1). */
  'circles:chat-add-channel': (input: { key: string; name: string }) => CirclesResult<{ id: string }>;
  'circles:chat-rename-channel': (input: { key: string; channel: string; name: string }) => CirclesResult;
  'circles:chat-remove-channel': (input: { key: string; channel: string }) => CirclesResult;
  /** Shared folders offered in a Circle, with what this Mac has of each (ADR 0049). */
  'circles:folders-list': (input: { key: string }) => CirclesResult<{ folders: SharedFolderListing[] }>;
  /** Shared services on Twenty's page (ADR 0048 §6, §8). */
  'circles:services': () => CirclesResult<{ view: SharedServicesView }>;
  'circles:service-share': (input: ServiceShareInput) => CirclesResult;
  'circles:service-stop-sharing': (input: { circle: string }) => CirclesResult;
  'circles:service-use': (input: { circle: string; provider: string; service: string; access: TwentyAccess }) => CirclesResult<{ slug: string }>;
  'circles:service-stop-using': (input: { circle: string; provider: string; service: string }) => CirclesResult;
  /** Why a folder can't be shared as it is, or null; checked before the share sheet's People step. */
  'circles:folder-check': (input: { path: string }) => { problem: SharedFolderProblem | null };
  /** Where a folder added from a Circle lives by default: `~/Circles/<Circle>/<folder>`. */
  'circles:folder-default-root': (input: { circle: string; name: string }) => string;
  'circles:folder-share': (input: ShareFolderInput) => CirclesResult<{ key: string; root: string }>;
  /** Add an offered folder to this Mac at `root`; `key` is the folder's. */
  'circles:folder-add': (input: { circle: string; key: string; root: string }) => CirclesResult;
  /** Stop syncing a folder here; `trash` moves its files to the Trash. */
  'circles:folder-remove': (input: { key: string; trash: boolean }) => CirclesResult;
  'circles:folder-set-role': (input: { key: string; identity: string; role: SharedFolderRole; name?: string }) => CirclesResult;
  /** File changes newest first: one file's versions with whether each is here, or every file's for Activity. */
  'circles:folder-history': (input: { key: string; path?: string }) => CirclesResult<{ history: SharedFolderChange[] }>;
  /** Write an older version back as a new change; `seq` names the version. */
  'circles:folder-restore': (input: { key: string; path: string; seq: number }) => CirclesResult;
  'circles:folder-compare': (input: { key: string; copy: string }) => CirclesResult<{ conflict: SharedFolderConflict }>;
  /** Settle a conflict copy with ordinary changes. */
  'circles:folder-resolve': (input: { key: string; copy: string; keep: 'original' | 'copy' | 'both' }) => CirclesResult;
  /** This Mac's shared folders, those from Circles it left included, for the project screen. */
  'circles:folders-on-mac': () => CirclesResult<{ folders: SharedFolderOnMac[] }>;
  /** What sharing a folder would send: file count, size, and the files that stay on this Mac. */
  'circles:folder-scan': (input: { path: string }) => FolderScan;
  /** The files in a folder this Mac has added. */
  'circles:folder-files': (input: { key: string }) => CirclesResult<{ files: SharedFolderFile[] }>;
  /** Opens this Mac's copy of a folder in Finder. */
  'circles:folder-reveal': (input: { key: string }) => CirclesResult;
  /** Tells members online that this user is typing; main sends at most one every 3 seconds. */
  'circles:chat-typing': (input: { key: string; channel: string }) => void;
  /** This user's direct conversations in a Circle, most recent first (ADR 0054). */
  'circles:dm-list': (input: { key: string }) => CirclesResult<{ conversations: DirectConversation[] }>;
  /** The newest messages with one person, or those before `before`, oldest first. */
  'circles:dm-messages': (input: { key: string; peer: string; before?: string; limit?: number }) => CirclesResult<{ messages: DirectMessage[]; more: boolean }>;
  'circles:dm-send': (input: { key: string; peer: string; text: string; reply?: CircleMessageRef }) => CirclesResult<{ id: string }>;
  'circles:dm-edit': (input: { key: string; peer: string; id: string; text: string }) => CirclesResult;
  /** `unsent` is true when the message never left this Mac. */
  'circles:dm-delete': (input: { key: string; peer: string; id: string }) => CirclesResult<{ unsent: boolean }>;
  /** Marks a conversation read on this device up to message `id`; the position never leaves this Mac. */
  'circles:dm-read': (input: { key: string; peer: string; id: string }) => CirclesResult;
  /** Tells the other person this user is typing, when they are online; at most one every 3 seconds. */
  'circles:dm-typing': (input: { key: string; peer: string }) => void;
  /** This device's notification settings for a Circle, the level they resolve to, and the Circle's people count. */
  'circles:notify-prefs': (input: { key: string }) => {
    prefs: CircleNotifyPrefs;
    resolved: 'all' | 'mentions' | 'nothing';
    people: number;
    global: CircleNotifyGlobal;
  };
  'circles:set-notify-prefs': (input: { key: string; prefs: CircleNotifyPrefs }) => void;
  'circles:set-notify-global': (input: CircleNotifyGlobal) => void;
  /** The channel on screen and whether the window has focus; null when none is. */
  'circles:viewing': (input: { circleKey: string; channel: string; focused: boolean } | null) => void;
  /** Whether this run has the call transport check on (`BOUNDARY_CALLS_CHECK=1`). */
  'circles:call-check-enabled': () => boolean;
  /** One part of a call check message to one member; false when the check is off or the part is wrong. */
  'circles:call-signal-send': (input: { key: string; to: string; part: CallPart }) => boolean;
  /** This device's address as the DHT sees it, for the check's `swarm` mode. */
  'circles:public-address': () => CirclesResult<{ address: CirclePublicAddress | null }>;
  /**
   * The call service's signals: a state to the whole Circle or, with `to`, to one member; a part or
   * a ring to one member. False when refused.
   */
  'circles:call-send': (
    input:
      | { key: string; topic: 'call.state'; state: CallState; to?: string }
      | { key: string; topic: 'call.part'; to: string; part: CallPart }
      | { key: string; topic: 'call.ring'; to: string; ring: CallRingMessage }
  ) => boolean;
  /** Log a call connection's connect or end as metadata; false when the event is wrong. */
  'circles:call-log': (input: CallLogInput) => boolean;
  /** A call tunnel to one member, for calls and the check: its local port after `open`, counts otherwise. */
  'circles:call-tunnel': (input: {
    action: 'open' | 'stats' | 'close';
    key: string;
    to: string;
    tunnel: number;
    /** One of the member's devices (64 hex); without it, the first connected one. */
    device?: string;
  }) => CirclesResult<{ port?: number; stats?: CallTunnelStats | null }>;
  /** Log one check result as metadata, with CPU use and the Circles connection to `to`; returns what was logged, or null. */
  'circles:call-check-result': (input: { key: string; to: string; result: CallCheckResult }) => CallCheckResult | null;
  /** Log one sample of a connection being measured; false when the check is off or the sample is wrong. */
  'circles:call-check-sample': (input: CallCheckSample) => boolean;
  /** Save this Mac's call check report where the tester picks; the label names the network. */
  'circles:call-check-export': (input: {
    label: string;
    results: CallCheckResult[];
  }) => IpcResult<{ path?: string; canceled?: boolean }>;
  /** The unread count on the app's icon; main ignores a malformed badge. */
  'app-badge:set': (badge: AppBadge) => void;
  /** **Keep the agent button on the desktop** (ADR 0058 §17): whether this platform has it, and its position. */
  'desktop-agent:get': () => { available: boolean; on: boolean; hidden: boolean; shortcut: string | null };
  'desktop-agent:set': (on: boolean) => IpcResult;
  /** **Hide button** (true), or **Show the agent button** (false). */
  'desktop-agent:set-hidden': (hidden: boolean) => IpcResult;
  /** The button follows a drag; the point is the button's centre in screen coordinates. */
  'desktop-agent:drag': (center: { x: number; y: number }) => void;
  /** The button snaps to the nearest edge and remembers it; null for a malformed point. */
  'desktop-agent:drop': (center: { x: number; y: number }) => DesktopAgentSpot | null;
  'desktop-agent:corner': (corner: 'Bottom right' | 'Bottom left' | 'Top right' | 'Top left') => void;
  /** The button's menu: the four corners and **Hide button**, as a system menu (ADR 0058 §5). */
  'desktop-agent:context-menu': () => void;
  /** Bring Boundary's window forward, for the panel's ⤢. */
  'desktop-agent:show-window': () => void;
  /** The shortcut that toggles the panel from any app, or null for none (ADR 0058 §11). */
  'desktop-agent:set-shortcut': (accelerator: string | null) => IpcResult;
  'appearance:get-theme': () => ThemePreference;
  'appearance:set-theme': (preference: ThemePreference) => IpcResult;
  /** The OS's camera and microphone access for the app; no prompt. */
  'media:get-access': () => MediaAccess;
  /** Shows the macOS prompt for one device if it hasn't been answered, then reports its status. */
  'media:request-access': (device: MediaDevice) => MediaAccessStatus;
  /** Opens System Settings at the camera or microphone privacy pane. */
  'media:open-privacy-settings': (device: MediaDevice) => void;
  /** Whether this window is in a call, so quitting can ask first. */
  'calls:live': (live: boolean) => void;
  /** The calls ringing for this user, sent whenever they change, so main can alert outside the window. */
  'calls:rings': (rings: RingAlert[]) => void;
  'urls:open-url': (url: string) => IpcResult;
  /** App details and redacted recent errors for a bug report; reads no session content. */
  'bug-report:collect': () => ReportContext;
  /** Save the report where the user picks; `saved` is false when they cancel. */
  'bug-report:save': (report: { title: string; body: string }) => IpcResult<{ saved?: boolean }>;

  'onboarding:get-status': () => InferenceProvidersStatus;
  'onboarding:clear-llm-slot': (input: ClearLlmSlotInput) => ClearOpenAiConfigResult;
  'onboarding:reconnect-saved-openrouter-key': () => SaveLlmConnectionResult;
  'onboarding:forget-saved-openrouter-key': () => ClearOpenAiConfigResult;
  'onboarding:set-app-default': (input: SetAppDefaultInput) => SetAppDefaultResult;
  'onboarding:set-app-fallbacks': (input: SetAppFallbacksInput) => SetAppFallbacksResult;
  /** The app's stack as main would plan it now, for Inference. Sends nothing to any model. */
  'inference:describe-app-stack': () => InferenceStack;
  'onboarding:set-app-shared-model': (input: SetAppSharedModelInput) => SetAppSharedModelResult;
  'onboarding:get-app-switch': () => AppSwitchEvent;
  'onboarding:cancel-app-switch': () => InferenceStatusResult;
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
  'stack-host:capabilities': () => StackHostCapabilities;
  'assistant-stack:get-lifecycle': () => AssistantStackLifecycleSnapshot;
  'assistant-stack:ensure-running': () => EnsureAssistantStackResult;
  'assistant-stack:ensure-running-background': () => { started: boolean };
  'assistant-stack:ensure-and-apply-llm': () => EnsureAssistantStackResult;
  'assistant-stack:get-web-search-mode': () => WebSearchModeState;
  'assistant-stack:set-web-search-mode': (mode: WebSearchMode) => IpcResult;

  'whats-new:get-state': () => WhatsNewSnapshot | null;
  'whats-new:mark-seen': (version: string) => void;
  'whats-new:set-popups': (on: boolean) => void;

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
  'resources:subscribe-compose-inventory': () => IpcResult;
  'resources:unsubscribe-compose-inventory': () => IpcResult;

  'host-bridge:approval-respond': (
    payload: HostBridgeApprovalRespondPayload
  ) => IpcResult;
  'host-bridge:approvals-pending': () => HostBridgeApprovalEvent[];
  'host-bridge:tools-state': () => HostToolsState;
  'host-bridge:report-screen': (screen: { view: string; sheet: string | null }) => void;
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
  'calendars:mac-status': () => MacStatusResult;
  /** macOS asks the person, so this resolves when they answer. */
  'calendars:mac-request-access': () => MacStatusResult;
  /** Restarts the calendar helper after it stopped. Takes no arguments. */
  'calendars:mac-restart-helper': () => MacStatusResult;
  'calendars:mac-connect': (payload: MacConnectPayload) => CalendarActionResult;
  'calendars:mac-set-calendars': (payload: MacCalendarsPayload) => CalendarActionResult;
  /** Opens System Settings at Privacy → Calendars. Takes no arguments. */
  'calendars:open-privacy-settings': () => CalendarPrepareResult;

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
  'hermes-chat:mark-mentions-seen': () => IpcResult;
  'hermes-chat:running-list': () => HermesRunningTurn[];
  'hermes-chat:open-agent-dm': (payload: HermesOpenAgentDmPayload) => HermesOpenAgentDmResult;
  'hermes-chat:branch': (payload: HermesChatBranchPayload) => HermesChatBranchResult;
  'hermes-chat:delete-failed-chat': (payload: HermesChatHistoryPayload) => IpcResult;
  'hermes-chat:save-reply': (payload: HermesSaveReplyPayload) => HermesSaveReplyResult;
  'hermes-chat:reveal-project-file': (
    payload: HermesRevealProjectFilePayload
  ) => HermesRevealProjectFileResult;
  'hermes-chat:read-html-preview': (payload: HermesHtmlPreviewPayload) => HermesHtmlPreviewResult;
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
  'hermes-chat:cancel': (payload: HermesChatCancelPayload) => IpcResult;
  /** **Run now** on a turn held for its local model server. */
  'hermes-chat:run-now': (payload: { requestId: string }) => IpcResult;
  'workload:replies-at-once': () => RepliesAtOnce | null;
  'workload:set-replies-at-once': (payload: { value: number | null }) => RepliesAtOnce | null;
  'hermes-chat:approval-respond': (
    payload: HermesChatApprovalRespondPayload
  ) => HermesChatRespondResult;
  'hermes-chat:approval-received': (
    payload: HermesChatApprovalAckPayload
  ) => IpcResult;
  /** Carries a credential value: never log it. */
  'hermes-chat:credential-respond': (
    payload: HermesChatCredentialRespondPayload
  ) => HermesChatRespondResult;
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
  'hermes-agents:set-writing-voices': (
    slug: string,
    voices: AgentWritingVoices
  ) => IpcResult<{ agent?: AgentProfile }>;

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
  /** What the Remove project sheet shows (ADR 0067). */
  'hermes-projects:remove-inspect': (payload: { projectId: string }) => HermesProjectRemoveInspect;
  'hermes-projects:remove': (payload: HermesProjectRemovePayload) => HermesProjectRemoveResult;
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

  /** Moving chat history (ADR 0070): the one history action's state, and whether it can run here. */
  'chat-history:status': () => ChatHistoryStatus;
  /** Asks for a parent folder, then starts the export; progress comes as `chat-history:changed`. */
  'chat-history:export': () => ChatHistoryExportStart;
  /** Stops the running history action. False when none was running. */
  'chat-history:cancel': () => boolean;
  /** Shows the last export's folder in the file manager. */
  'chat-history:reveal': (folder: string) => IpcResult;
  'writing-voices:list': () => WritingVoiceListResult;
  'writing-check:detector-status': () => DetectorStatus;
  'writing-check:detector-check': (payload: { text: string }) => DetectorCheckResult;
  'writing-check:detector-agree': (payload: { provider: DetectorProvider }) => IpcResult;
  'writing-check:file-read': (payload: WritingCheckFilePayload) => WritingCheckFileResult;
  'writing-check:file-pick': (payload: WritingCheckPickPayload) => WritingCheckFileResult;
  'writing-voices:check': (sources: WritingVoiceSource[]) => WritingVoiceCheckSummary;
  'writing-voices:pick': () => WritingVoicePickResult;
  'writing-voices:create': (payload: WritingVoiceCreatePayload) => WritingVoiceCreateResult;
  'writing-voices:calibrate': (id: string) => WritingVoiceActionResult;
  'writing-voices:samples': (id: string) => WritingVoiceSamplesResult;
  'writing-voices:add-samples': (id: string, sources: WritingVoiceSource[]) => WritingVoiceViewResult;
  'writing-voices:remove-sample': (id: string, name: string) => WritingVoiceViewResult;
  'writing-voices:never-does': (id: string, lines: string[]) => WritingVoiceViewResult;
  'writing-voices:rename': (id: string, name: string) => WritingVoiceViewResult;
  'writing-voices:delete': (id: string) => WritingVoiceActionResult;
  'writing-voices:users': (id: string) => WritingVoiceUsersResult;
  'writing-voices:chat-get': (
    sessionId: string
  ) => IpcResult<{ voice?: HermesSessionWritingVoice }>;
  'writing-voices:chat-set': (
    sessionId: string,
    voiceId: string | null
  ) => IpcResult<{ voice?: HermesSessionWritingVoice }>;
  'writing-voices:open-style': (id: string) => WritingVoiceActionResult;
  'writing-voices:reveal': (id: string) => WritingVoiceActionResult;

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
  /** **Keep the agent button on the desktop** changed. */
  'desktop-agent:changed': boolean;
  /** The desktop button was hidden or shown again. */
  'desktop-agent:hidden': boolean;
  /** Boundary's window was shown or hidden; the page pauses on-screen-only work while hidden (ADR 0058). */
  'app-window:shown': boolean;
  /** Play the ring sound, or stop it: a call is ringing while the window isn't in front. */
  'calls:ring-sound': boolean;
  /** **Answer** or **Decline** on a ring's notification. */
  'calls:ring-action': RingAction;
  /** The confidential pool's providers or settings changed. */
  'confidential:state': ConfidentialState;
  'addons:progress': AddonInstallSnapshot;
  /** The add-on changes waiting for an assistant restart, whenever the list changes. */
  'addons:pending-changed': string[];
  /** Bitwarden's accounts and requests, each time main reads them. */
  'addons:bitwarden-changed': BitwardenOverview;
  'addons:email-changed': EmailOverview;
  'circles:state': CirclesState;
  /** One channel's new, changed and settled-away messages. */
  'circles:chat-event': CircleChatUpdate;
  /** A Circle's channels may have changed: added, renamed or removed. */
  'circles:chat-channels': { circleKey: string };
  /** A shared folder or an offer changed; `key` is the folder's, or empty when this Mac left a Circle and several ended. */
  'circles:folder-changed': { key: string };
  /** An offer appeared, changed or went, or this user started or stopped using one. */
  'circles:services-changed': void;
  /** A member's typing or read mark, from a peer signal. */
  'circles:chat-presence': CircleChatPresence;
  /** A direct message arrived, changed, was unsent or ended, or the other person is typing. */
  'circles:dm-event': DirectEvent;
  /** A notification was clicked: open this message. */
  'circles:open-message': { circleKey: string; channel: string; ref: CircleMessageRef };
  /** One part of a member's call check message. */
  'circles:call-signal': { circleKey: string; from: string; part: CallPart };
  /** A member's call signal; `device` is the device of theirs it came from. */
  'circles:call':
    | { circleKey: string; from: string; device: string; topic: 'call.state'; state: CallState }
    | { circleKey: string; from: string; device: string; topic: 'call.part'; part: CallPart }
    | { circleKey: string; from: string; device: string; topic: 'call.ring'; ring: CallRingMessage };
  'app:menu-command': AppCommand;
  'local-llm:changed': LocalLlmChangedPayload;
  'capability:progress': string;
  /** The container runtime resolve entered a stage (setup's Preparing screen). */
  'capability:provision-stage': RuntimeProvisionSnapshot;
  'assistant-stack:lifecycle': AssistantStackLifecycleSnapshot;
  /** The stack's health check passed or stopped passing. */
  'assistant-stack:ready': boolean;
  /** A slot's health changed in main (a probe, or the local model appearing or going). */
  'onboarding:status': InferenceProvidersStatus;
  'onboarding:app-switch': AppSwitchEvent;
  'resources:compose-inventory': ComposeInventorySnapshot;
  'updates:state': UpdateSnapshot;
  'whats-new:state': WhatsNewSnapshot;
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
  /** A turn's end was noted (fallback marks, pool provider): the chat's ids, any of which it may be open under. */
  'hermes-chat:inference-noted': { sessionIds: string[] };
  'hermes-agents:changed': void;
  'hermes-kanban:snapshot': KanbanSnapshot;
  'hermes-kanban:open-task': string;
  'coding-folders:progress': string;
  'writing-voices:progress': WritingVoiceProgress;
  'chat-history:changed': ChatHistoryState;
  /** A voice was created, deleted, renamed or edited. */
  'writing-voices:changed': void;
  'hermes-projects:create-progress': ProjectCreateProgressEvent;
  'coding-folders:access-request': CodingAccessRequestEvent;
}

export type IpcChannel = keyof IpcInvokeChannels;
export type IpcArgs<C extends IpcChannel> = Parameters<IpcInvokeChannels[C]>;
export type IpcReturn<C extends IpcChannel> = ReturnType<IpcInvokeChannels[C]>;
export type IpcEventChannel = keyof IpcEventChannels;
