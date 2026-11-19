import { slugify } from '../utils/slug';
import type { IpcResult } from '../ipc/result';
import type { CodingAgentBusy } from './codingFolders';
import type { ProjectCreateWhenBusy } from './projectCreate';

/** Built-in default agent slug — no Hermes profile; today’s single chat, named. */
export const BUILTIN_ASSISTANT_SLUG = 'assistant';

/**
 * ADR 0023: a titled chat with the built-in agent, a personality's one ongoing DM, any other
 * session a personality ran (branches, pre-0023 extras), or a room.
 */
export type HermesConversationKind = 'hermes' | 'dm' | 'side' | 'channel';

export interface AgentProfile {
  slug: string;
  displayName: string;
  /** @ handle shown in chrome (usually display name). */
  handle: string;
  role: string;
  builtIn: boolean;
  createdAt: string;
  /** Writing voice for chat replies (ADR 0056 §5); absent or null is No voice. */
  chatRepliesVoiceId?: string | null;
  /** Writing voice for drafts the agent writes for the person to use elsewhere. */
  draftsVoiceId?: string | null;
}

/** Local-first room: shared transcript + explicit member list (0008). */
export interface ChannelRecord {
  id: string;
  slug: string;
  title: string;
  sessionId: string;
  memberSlugs: string[];
  createdAt: string;
  updatedAt: string;
  /** The project the room belongs to; null or absent is No project (ADR 0024). */
  projectId?: string | null;
}

/** Last-opened conversation after ready — never Recent. */
export interface HermesLastOpened {
  kind: 'hermes' | 'dm' | 'channel';
  /** Session id for Hermes chats and DMs; channel id for rooms. */
  id: string;
}

export interface HermesChatThreadSummary {
  id: string;
  title: string;
  updatedAt?: string;
  /** When the session started, if the source says (headers: "started …", "since …"). */
  createdAt?: string;
  /** Gateway session source (e.g. webui, boundary, cli, telegram). */
  source?: string;
  /** Which agent owns this conversation. Defaults to Assistant when omitted. */
  agentSlug?: string;
  /** Hermes chat, a personality's standing DM, a side chat, or a channel (ADR 0023). */
  kind?: HermesConversationKind;
  /** Set when kind is channel. */
  channelId?: string;
  /** Channel slug for rail / Recent meta. */
  channelSlug?: string;
  /** Set when this chat was branched from another (message-actions Phase 3). */
  branch?: HermesChatBranchInfo;
  /**
   * The project the conversation lives in, or null for No project (ADR 0024). For a DM it is
   * the folder the agent works in, not a filing.
   */
  projectId?: string | null;
  /** The session's working folder as Hermes last reported it (session.list); main only. */
  cwd?: string;
  /** Hermes holds nothing for this chat: only Boundary's record of its failed sends. */
  failed?: boolean;
}

/** A send that left nothing in Hermes, kept so the message and its error aren't lost. */
export interface HermesFailedTurn {
  id: string;
  /** The user's message. Lives only in the app's local store. */
  text: string;
  noReply: HermesNoReply;
  errorCode?: HermesChatStartErrorCode;
  /** ISO time of the send; places the turn among Hermes's rows. */
  at: string;
  /** The voice chip it was sent with, so its Retry keeps the voice (ADR 0056 §6). */
  writingVoiceId?: string;
}

/** Boundary's record of a chat's failed sends, by stored session id or a local id. */
export interface HermesFailedChat {
  title: string;
  agentSlug: string;
  /** The id is Boundary's own: no Hermes session has ever had it. */
  local?: true;
  turns: HermesFailedTurn[];
}

/** ADR 0024: a project move, or a DM's folder change, shown in the transcript only. */
export interface SessionProjectMark {
  id: string;
  at: string;
  /** `moved` re-files a chat or channel; `folder` changes the folder a DM works in. */
  kind: 'moved' | 'folder';
  fromProjectId: string | null;
  toProjectId: string | null;
  /** Names and path when the mark was made, so it still reads after a project is removed. */
  fromName?: string;
  toName?: string;
  toPath?: string;
}

/** Re-file conversations under a project, or under No project with `projectId: null`. */
export interface HermesMoveToProjectPayload {
  sessionIds: string[];
  projectId: string | null;
  /** A chat with no messages yet is re-filed without a transcript mark (its composer chip). */
  quiet?: boolean;
}

/** One conversation's move, enough to undo it. */
export interface HermesProjectMove {
  sessionId: string;
  fromProjectId: string | null;
  toProjectId: string | null;
  /** Empty for a quiet move, which leaves no mark. */
  markId: string;
}

export interface HermesMoveToProjectResult {
  success: boolean;
  /** Conversations that changed; ones already in the target are left out. */
  moved: HermesProjectMove[];
  /** Set when a turn is running in one of the conversations; nothing moved. */
  errorCode?: 'running' | 'not-found';
  error?: string;
}

/**
 * The answer to a parked approval or credential prompt. `errorCode: 'not-pending'` means main no
 * longer holds the request (answered elsewhere, withdrawn, timed out, or its socket dropped), so
 * the card can go.
 */
export type HermesChatRespondResult = IpcResult<{ errorCode?: 'not-pending' }>;

export interface HermesUndoProjectMovePayload {
  moves: HermesProjectMove[];
}

export interface HermesCreateHermesChatPayload {
  /** The project the chat starts in (the rail's project); null for No project. */
  projectId?: string | null;
}

/** Where a branched chat came from; kept in Boundary's session meta. */
export interface HermesChatBranchInfo {
  /** The parent's stored session id (durable across restarts). */
  parentId: string;
  /** The parent's title when the branch was made, so the label never needs a lookup. */
  parentTitle?: string;
  /** How many leading messages were copied from the parent (they carry no times). */
  seededCount: number;
  branchedAt: string;
}

export interface HermesChatBranchPayload {
  parentSessionId: string;
  agentSlug?: string;
  /** Title of the parent chat; the branch is "<title> · branch". */
  parentTitle?: string;
  /** The visible messages up to the cut, text only (CR 0001 R2 stopgap). */
  seed: HermesChatMessage[];
}

/** Save a reply as a Markdown file; the save dialog opens in the project folder. */
export interface HermesSaveReplyPayload {
  projectId: string;
  content: string;
}

export interface HermesSaveReplyResult {
  success: boolean;
  path?: string;
  /** The user closed the dialog; nothing was written. */
  canceled?: boolean;
  error?: string;
}

/** Show a file the agent wrote in Finder; only paths inside the project folder. */
export interface HermesRevealProjectFilePayload {
  projectId: string;
  relativePath: string;
}

export type HermesRevealProjectFileResult = IpcResult;

/** Read an HTML page an agent wrote, by its path inside the containers. */
export interface HermesHtmlPreviewPayload {
  containerPath: string;
}

export type HermesHtmlPreviewResult = IpcResult<{ html?: string; name?: string }>;

export type HermesChatBranchResult = HermesChatCreateThreadResult;

/** Human-facing label for a gateway session source. */
export function hermesSessionSourceLabel(source?: string | null): string | null {
  const raw = (source ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'webui') return 'WebUI';
  if (raw === 'boundary' || raw === 'tui' || raw === 'cli' || raw === 'desktop') {
    return 'App';
  }
  if (raw === 'api_server' || raw === 'api-server') return 'API';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** How a channel user line entered the room (0009). */
export type HermesChatDelivery = 'posted' | 'woke';

export interface HermesChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Which agent spoke this assistant turn (channel multi-speaker). */
  agentSlug?: string;
  /** Channel user line: bulletin vs @-address. Omitted on DMs and assistant turns. */
  delivery?: HermesChatDelivery;
  /** When the message was stored, unix seconds. Omitted when the source has no time. */
  timestamp?: number;
  /** Durable Hermes transcript row id (rewind / edit target). Gateway rows only. */
  rowId?: number;
  /** Assistant turns: paths the turn's tools wrote (container paths, as Hermes saw them). */
  files?: string[];
  /** Assistant turns: how many tools ran in the whole turn. Omitted when unknown. */
  toolCount?: number;
  /** Assistant turns: kanban tasks the turn filed (`kanban_create`), in call order. */
  tasksFiled?: import('./hermesKanban').KanbanFiledTask[];
  /** Assistant turns cut short: how the reply ended (Boundary's note; Hermes keeps only the text). */
  ending?: HermesReplyEnding;
  /** User turns whose reply never came: why (Boundary's note; Hermes saves nothing). */
  noReply?: HermesNoReply;
  /** A failed send from Boundary's own record: Hermes has no row for it. */
  localOnly?: boolean;
  /** The writing voice the reply was written in (assistant rows), from Boundary's notes. */
  writingVoiceName?: string;
}

/**
 * How a reply was cut short (run-control spec). `stopped`: the user pressed Stop.
 * `interrupted`: the user sent a new message over it (Send now, Phase 2).
 */
export type HermesReplyEnding = 'stopped' | 'interrupted';

/**
 * Why a turn ended before any reply text. `stopped`/`interrupted` as above; `failed`: Hermes
 * or the provider reported an error; `halted`: Hermes ended the turn itself; `timeout`:
 * Boundary gave up waiting; `empty`: the turn completed with no text. `unknown` is never
 * stored: the renderer shows it for an unanswered message with no note and no turn running.
 */
export type HermesNoReplyReason =
  | 'stopped'
  | 'interrupted'
  | 'failed'
  | 'halted'
  | 'timeout'
  | 'empty'
  /** Boundary refused the send because nothing answered its health check. Live only. */
  | 'unreachable'
  /** The user stopped the send while it waited for the local model; it was never submitted. */
  | 'withdrawn'
  | 'unknown';

export interface HermesNoReply {
  reason: HermesNoReplyReason;
  /** Provider or Hermes error text, when there was one. */
  error?: string;
  /** The identity of the Circle member whose shared model couldn't serve. */
  provider?: string;
}

/** A turn Boundary is running on Hermes (any window, including detached chats). */
export interface HermesRunningTurn {
  requestId: string;
  /** Every id the renderer may hold for the chat (runtime and stored). */
  sessionIds: string[];
  agentSlug: string | null;
  /** ISO time the turn was submitted. */
  startedAt: string;
  /**
   * `held`: waiting in Boundary for a slot on its local model server (workload plan Phase 1a),
   * not yet submitted. Absent or `running` otherwise.
   */
  admission?: 'held' | 'running';
}

/** Replies at once for the local model server (Settings → Inference, workload plan Phase 1a). */
export interface RepliesAtOnce {
  /** The server's origin. */
  server: string;
  /** What turns are held to: `override`, else `reported`, else 1. */
  limit: number;
  /** The parallel count the server reports for the selected model, when it reports one. */
  reported?: number;
  /** The user's setting, when they changed it. */
  override?: number;
}

/** A turn waiting for its local model server, as the `held` phase reports it. Ids only. */
export interface HermesHeldTurn {
  /** 1 for the next turn to start. */
  position: number;
  /** Turns ahead of this one: those running on the server plus those waiting before it. */
  ahead: number;
  /** Turns the server runs at once. */
  limit: number;
  /** A session id for each turn running on the server, for the chat names the line links. */
  runningSessionIds: string[];
}

/**
 * One @ you sent an agent in a room, with that agent's reply (ADR 0023 §6). Built from the
 * room's posts and Hermes's transcript; nothing new is stored but a cache. Channels only.
 */
export interface HermesMentionRecord {
  /** Post id + agent slug: one record per mentioned agent. */
  id: string;
  channelId: string;
  channelSlug: string;
  /** The room's stored session id. */
  sessionId: string;
  agentSlug: string;
  /** Your message, as sent. */
  text: string;
  /** When you sent it (ISO). */
  at: string;
  /** `replied` once the agent answered; `waiting` until then. "Replied later" is future (0009). */
  status: 'replied' | 'waiting';
  reply?: { text: string; at: string };
  /** The reply arrived after Mentions was last opened. */
  unseen: boolean;
}

export interface HermesMentionsListResult {
  success: boolean;
  mentions: HermesMentionRecord[];
  error?: string;
}

/** Local-first channel user line. Lives in the room overlay until a gateway append exists. */
export interface ChannelPostRecord {
  id: string;
  content: string;
  createdAt: string;
  delivery: HermesChatDelivery;
  /** Set when this post was included in a later wake prompt. */
  consumedAt?: string | null;
  /** Assistant turns that followed this wake (for history interleave). */
  assistantCount?: number;
}

export interface HermesChatStartPayload {
  requestId?: string;
  sessionId?: string;
  messages: HermesChatMessage[];
  /** When false, disable session toolsets before prompt.submit when the gateway supports it. */
  toolsEnabled?: boolean;
  /** Route the turn to this agent’s Hermes profile when not the built-in Assistant. */
  agentSlug?: string;
  /** Edit / Retry: replace history from this user turn onward instead of appending. */
  rewind?: HermesChatRewindRequest;
  /** Retry of a failed send Hermes never held: a plain send, and a later failure replaces it. */
  retry?: boolean;
  /**
   * Continue a stopped reply: submit a hidden continue instruction instead of a user turn.
   * Hermes kept the partial, so the new reply picks up from it. Gateway DMs only.
   */
  continue?: boolean;
  /**
   * Sent from the desktop's queue after a reply completed (run-control spec 2.4). If Hermes is
   * still releasing that turn, it holds this prompt and runs it next instead of redirecting.
   * Gateway DMs only; a channel wake ignores it.
   */
  queued?: boolean;
  /** Which run control sent this (the queue, Send now); logged only. */
  via?: HermesRunControl;
  /**
   * The project for the chat when this send creates its session (an empty composer). Ignored
   * once the chat exists: its stored project applies (ADR 0024).
   */
  projectId?: string | null;
  /**
   * The chat's inference when this send creates its session (Send via OpenRouter from an
   * empty chat). Ignored once the chat exists: set it with `hermes-chat:set-session-inference`.
   */
  inference?: SessionInferenceOverride;
  /** A voice chip on this message (ADR 0056 §6): sent as this turn's context. */
  writingVoiceId?: string;
  /** A voice kept for a chat that has no session yet; stored on the session this send creates. */
  keptWritingVoiceId?: string | null;
}

/** The user turn an Edit or Retry replaces, as the renderer last saw it on the server. */
export interface HermesChatRewindRequest {
  /** 0-based index among the session's user turns. */
  userOrdinal: number;
  /** Durable row id when the renderer has it from history; preferred over the ordinal. */
  rowId?: number;
  /** The replaced turn's text, so main can confirm the target before cutting. */
  expectedText: string;
}

export type HermesChatStartErrorCode =
  | 'gateway-unreachable'
  | 'local-unreachable'
  /** Nothing the chat would use answered a health check, so nothing was restarted or sent. */
  | 'provider-unreachable'
  /** The privacy lock left the chat's chain with nothing to send to (ADR 0033 §4). */
  | 'private-refused'
  | 'apply-failed'
  | 'rewind-stale'
  | 'rewind-unsupported';

export interface HermesChatStartResult {
  success: boolean;
  requestId: string;
  sessionId?: string;
  /** The stored id behind `sessionId`, which is the id chat lists use. */
  storedSessionId?: string;
  error?: string;
  errorCode?: HermesChatStartErrorCode;
  /** The chat's shared model can't serve either; `error` says so. */
  sharedUnavailable?: boolean;
  /** The identity of the Circle member whose shared model stopped the send. */
  provider?: string;
  /** Channel send with no member @ — persisted as a post, no model turn. */
  posted?: boolean;
  /** The writing voice this turn's reply is written in, for its details. */
  writingVoiceName?: string;
}

/**
 * Which run control started a send or cut a run short, for the turn debug log only
 * (run-control spec, Phase 2): a queue drain, Send now by ⌘↵, by the menu (Enter or a
 * click) or on a queue chip, or Stop.
 */
export type HermesRunControl =
  | 'queue-drain'
  | 'send-now-cmd-enter'
  | 'send-now-menu-enter'
  | 'send-now-menu-click'
  | 'send-now-chip'
  | 'stop';

export interface HermesChatCancelPayload {
  requestId: string;
  /** Stop the chat's running turn whatever its request id (a window reopened mid-turn). */
  sessionId?: string;
  /** Why the run is being cut short; recorded on the partial reply. Defaults to `stopped`. */
  reason?: HermesReplyEnding;
  /** Which control cut it short; logged only. */
  via?: HermesRunControl;
}

export interface HermesChatChunkEvent {
  requestId: string;
  delta: string;
  agentSlug?: string;
}

export interface HermesChatSpeakerEvent {
  requestId: string;
  sessionId?: string;
  agentSlug: string;
  /** The writing voice this speaker's reply is written in (a room member, ADR 0056 §7). */
  writingVoiceName?: string;
}

export interface HermesChatEndEvent {
  requestId: string;
  finishReason?: string;
  sessionId?: string;
  /** Set when the turn ended without any reply text. */
  noReply?: HermesNoReply;
  /** When main saw the turn finish (ms), for a reply that finished; not on a cancel. */
  endedAt?: number;
}

export interface HermesChatErrorEvent {
  requestId: string;
  error: string;
}

export interface HermesChatListThreadsResult {
  success: boolean;
  threads: HermesChatThreadSummary[];
  error?: string;
}

export type HermesChatCreateThreadResult = IpcResult<{ thread?: HermesChatThreadSummary }>;

export interface HermesOpenAgentDmPayload {
  agentSlug: string;
  /** The folder a new DM starts in. An existing DM keeps its own (ADR 0024 §7). */
  projectId?: string | null;
}

export interface HermesOpenAgentDmResult extends HermesChatCreateThreadResult {
  /** True when no standing DM existed and one was made. */
  created?: boolean;
}

export interface HermesAgentsListResult {
  success: boolean;
  agents: AgentProfile[];
  /** Standing DM session id per agent slug (may be null if none yet). */
  standingDmByAgent: Record<string, string | null>;
  /** The Orchestrator's slug once Boundary has created or adopted it, so the rail can show it before its first DM. */
  orchestratorSlug?: string | null;
  error?: string;
}

export interface HermesAgentCreatePayload {
  displayName: string;
  handle?: string;
  role: string;
}

export interface HermesAgentCreateResult {
  success: boolean;
  agent?: AgentProfile;
  error?: string;
}

export interface HermesAgentUpdatePayload {
  slug: string;
  displayName: string;
  handle?: string;
  role: string;
}

export interface HermesAgentUpdateResult {
  success: boolean;
  agent?: AgentProfile;
  /** SOUL.md had been edited by hand, so the new name and role weren't written into it. */
  soulKept?: boolean;
  /** Saved, but Hermes didn't take the change; or why nothing was saved. */
  error?: string;
}

export interface HermesAgentSoulPayload {
  slug: string;
}

export interface HermesAgentSoulResult {
  success: boolean;
  excerpt?: string | null;
  canOpen?: boolean;
  error?: string;
}

export interface HermesChannelsListResult {
  success: boolean;
  channels: ChannelRecord[];
  lastOpened?: HermesLastOpened | null;
  error?: string;
}

export interface HermesChannelCreatePayload {
  title: string;
  slug?: string;
  /** Initial member agent slugs. */
  memberSlugs?: string[];
  /** The project the room starts in (the rail's project); null for No project. */
  projectId?: string | null;
}

export type HermesChannelCreateResult = IpcResult<{
  channel?: ChannelRecord;
  thread?: HermesChatThreadSummary;
}>;

export interface HermesChannelAddMemberPayload {
  channelId: string;
  agentSlug: string;
}

export type HermesChannelAddMemberResult = IpcResult<{ channel?: ChannelRecord }>;

export interface HermesChannelRenamePayload {
  channelId: string;
  /** The new name; a leading # is dropped. */
  title: string;
  /** Defaults to one made from the name; kept unique among rooms. */
  slug?: string;
}

export type HermesChannelRenameResult = HermesChannelAddMemberResult;

export interface HermesChannelDeletePayload {
  channelId: string;
}

export interface HermesChannelDeleteResult {
  success: boolean;
  /** The room's sessions, now Hermes chats in its project. */
  sessionIds?: string[];
  /** The project they were filed in, or null for No project. */
  projectId?: string | null;
  error?: string;
}

export interface HermesMakeChannelFromChatPayload {
  sessionId: string;
  title: string;
  slug?: string;
  memberSlugs?: string[];
}

export type HermesMakeChannelFromChatResult = HermesChannelCreateResult;

export interface HermesSetLastOpenedPayload {
  kind: HermesLastOpened['kind'];
  id: string;
}

export interface HermesSetLastOpenedResult {
  success: boolean;
  lastOpened?: HermesLastOpened | null;
  error?: string;
}

/** Proposed agent card from a fenced agent-draft block (0008 draft-from-chat). */
export interface AgentDraftProposal {
  displayName: string;
  handle: string;
  role: string;
}

export interface HermesChatHistoryPayload {
  sessionId: string;
}

export interface HermesChatHistoryResult {
  success: boolean;
  messages: HermesChatMessage[];
  /** Runtime session id after resume (may differ from the stored id). */
  sessionId?: string;
  /** Set for a branched chat, so the copied messages can be told apart. */
  branch?: HermesChatBranchInfo;
  error?: string;
}

/** Live usage / phase telemetry pushed during a turn (JSON-RPC) or at finish (HTTP). */
export type HermesChatPhase =
  | 'idle'
  | 'preparing'
  | 'restarting'
  /** Waiting in Boundary for a slot on the local model server; `held` says where. */
  | 'held'
  | 'tool'
  | 'generating'
  | 'done';

/** Chat override may only name a visible provider (Phase 2). */
export type ChatInferenceProvider = 'local' | 'openrouter';

export type InferenceProvenance =
  | 'chat-override'
  | 'project-default'
  | 'app-default';

/** Project pin: inherit app default, or pin a visible provider (+ optional model). */
export type ProjectInferenceMode = 'inherit' | ChatInferenceProvider;

export interface ProjectInferencePin {
  mode: ProjectInferenceMode;
  modelId?: string;
  /** The project is private: every chat in it obeys the privacy lock (ADR 0033 §4). */
  privacyLocalOnly?: boolean;
  /**
   * The private project lets its pools use level B providers, below Pool settings' private
   * minimum (confidential inference spec decision 10). Only meaningful while `privacyLocalOnly`.
   */
  allowConfidentialLevelB?: boolean;
  /** Tried in order when the pinned provider doesn't answer (ADR 0033). Ignored while inheriting. */
  fallbacks?: import('./inferenceChain').InferenceChainEntry[];
}

export interface SessionInferenceOverride {
  provider: ChatInferenceProvider;
  modelId: string;
  /** Tried in order when the override doesn't answer (ADR 0033). */
  fallbacks?: import('./inferenceChain').InferenceChainEntry[];
}

/** A chat's kept writing voice changed (ADR 0056 §6); the transcript shows a line for it. */
export interface WritingVoiceMark {
  id: string;
  at: string;
  kind: 'kept' | 'cleared';
  voiceId: string | null;
  /** The voice's name when the mark was made, so the line reads the same after a delete. */
  voiceName: string | null;
}

/** A chat's kept writing voice, and the marks it left. */
export interface HermesSessionWritingVoice {
  voiceId: string | null;
  voiceName: string | null;
  marks: WritingVoiceMark[];
}

export interface SessionInferenceMark {
  id: string;
  at: string;
  /**
   * `fell-back`: a turn was answered by a later entry of the inference chain (ADR 0033 §3).
   * `recovered`: the chain's first entry answered again after a `fell-back`.
   */
  kind: 'switched' | 'fell-back' | 'recovered';
  /** `peer`: a model shared in a Circle (ADR 0034). */
  provider: ChatInferenceProvider | 'peer';
  modelId: string;
  /** Who shared the model, when `provider` is `peer` and they are still in the Circle. */
  sharedBy?: { person: string; circle: string };
}

/**
 * A turn a confidential pool answered, and which provider (ADR 0047, confidential inference spec
 * decision 9). Dated from the turn's start. Ids, names and the level only: no message text.
 */
export interface PoolServedTurn {
  at: string;
  /**
   * The `startedAt` of the turn's `TurnWindow`, so a reply is matched to this record through its
   * window, never by time alone. Null when the turn had no window.
   */
  windowStartedAt: string | null;
  /** The pool's canonical model id. */
  modelId: string;
  providerId: string;
  /** The provider's catalog name when the turn ran. */
  providerName: string;
  level: import('./confidential').TrustLevel;
  /** Why the chat moved to this provider on this turn; null when it stayed. */
  moved: import('./confidential').PoolMoveReason | null;
  /**
   * More than one provider answered the turn's requests (a room wake runs several agents), so
   * the provider above is only the last request's.
   */
  mixedProviders: boolean;
}

/**
 * When one of a chat's turns ran: from the send reaching main to the turn ending (ISO). Times only.
 * `endedAt` is null while the turn runs. A send that never ran a turn ends at its start.
 */
export interface TurnWindow {
  startedAt: string;
  endedAt: string | null;
}

export interface ResolvedSessionInference {
  /** A confidential pool only as the app default's first entry; `modelId` is then its canonical id. */
  slot: import('./inferenceChain').InferenceChainSlot;
  modelId: string;
  /** For `peer`, the shared model's own label (ADR 0036). */
  providerDisplayName: string;
  /** Which shared model, when `slot` is `peer`. */
  peer?: import('./inferenceChain').PeerModelRef;
  provenance: InferenceProvenance;
  configured: boolean;
  health?: import('./onboarding').LlmSlotHealth;
  needsRestart: boolean;
  /** The fallbacks of the level that supplied this; levels are not merged (ADR 0033 §1). */
  fallbacks?: import('./inferenceChain').InferenceChainEntry[];
  /** The chat's project is private. Set on chat snapshots. */
  privacyLocked?: boolean;
  /** The chat's project is private and its chain has no private model, so a send is refused. */
  privacyRefused?: boolean;
  /**
   * The lowest provider level the private project's pools may use, as main plans its chat. Set
   * with `privacyLocked` while confidential pools are on, so the chip ranks pools the same way.
   */
  projectFloor?: import('./confidential').TrustLevel;
  /**
   * Set with `privacyRefused` when the chain lists a pool no added provider qualifies for at
   * `projectFloor`: each one and why, for the chat's stop (confidential inference spec decision 10).
   */
  poolStop?: import('./confidentialState').PoolStop;
}

export interface HermesSessionInferencePayload {
  sessionId: string;
}

export interface HermesSessionInferenceSetPayload {
  sessionId: string;
  provider: ChatInferenceProvider;
  modelId: string;
  /** Omitted keeps the chat's current fallbacks. */
  fallbacks?: import('./inferenceChain').InferenceChainEntry[];
}

export interface HermesSessionInferenceResult {
  success: boolean;
  override: SessionInferenceOverride | null;
  resolved: ResolvedSessionInference | null;
  marks: SessionInferenceMark[];
  /** Turns a confidential pool answered, oldest first. */
  poolTurns: PoolServedTurn[];
  /** When each of the chat's turns ran, oldest first, whatever answered it. */
  turnWindows: TurnWindow[];
  error?: string;
}

export interface HermesChatUsageSnapshot {
  contextUsed?: number | null;
  contextMax?: number | null;
  contextPercent?: number | null;
  contextEstimated?: boolean | null;
  avgTps?: number | null;
  prompt?: number | null;
  completion?: number | null;
}

export interface HermesChatPhaseEvent {
  requestId: string;
  sessionId?: string;
  phase: HermesChatPhase;
  toolName?: string;
  toolTurn?: number;
  maxTurns?: number;
  elapsedSec?: number;
  visibleTokens?: number;
  usage?: HermesChatUsageSnapshot;
  /** The chat's shared model can't serve, so it is leaving the router. */
  sharedUnavailable?: boolean;
  /** `preparing`: Hermes is parked on its recovery ladder, waiting to try the provider again. */
  recovery?: HermesRecoveryWait;
  /** `held`: the turn's place in line for its local model server. */
  held?: HermesHeldTurn;
}

/** One rung of Hermes's auto-recovery ladder (`agent/turn_recovery_autorecover.py`). */
export interface HermesRecoveryWait {
  cycle: number;
  total: number;
  /** Seconds until the next try; 0 once Hermes is trying again. */
  retryInSec: number;
  /** Who it's waiting for; absent on a chain, where the router tried them all. */
  provider?: string;
}

export interface HermesChatContextFile {
  label: string;
  path: string;
  chars: number;
  estTokens: number;
  loaded: boolean;
  status: string;
}

/**
 * Where a session's history budget cuts the transcript (CR 0002 R2). The stack decides the
 * cut; desktop only draws it. `budget: null` means the session has no budget.
 */
export interface HermesHistoryWindow {
  budget: number | null;
  /** Tokens of history sent: the verbatim tail plus any summary. */
  tokens: number | null;
  /** First transcript row the model sees verbatim. */
  firstRowId: number | null;
  /** True when rows before `firstRowId` reach the model as a compression summary. */
  summarised: boolean;
}

export interface HermesChatContextBreakdown {
  categories: Array<{ id: string; label: string; tokens: number; color?: string }>;
  contextUsed: number;
  contextMax: number;
  contextPercent: number;
  contextEstimated: boolean;
  model?: string;
  contextFiles?: HermesChatContextFile[];
  /** The next reply's history cut. Absent when the stack doesn't report one (no R2). */
  history?: HermesHistoryWindow;
}

export type HermesChatToolStatus = 'running' | 'generating' | 'done';

export interface HermesChatToolEvent {
  requestId: string;
  sessionId?: string;
  toolId: string;
  name: string;
  status: HermesChatToolStatus;
  turn?: number;
  maxTurns?: number;
  args?: Record<string, unknown>;
  /** What the tool card shows: Hermes's summary, or the result when there is none. */
  summary?: string;
  /** The tool's own answer (`result_text`), e.g. kanban_create's `{"ok": …}` JSON. */
  result?: string;
  durationSec?: number;
  paths?: string[];
}

export type HermesApprovalChoice = 'once' | 'session' | 'always' | 'deny';

/**
 * The MCP call behind an approval, sent for tools on `trust: untrusted` servers (stack v0.3.3).
 * Hermes redacts and caps the arguments before sending them.
 */
export interface HermesApprovalMcpCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown> | null;
  toolCallId?: string;
}

export interface HermesChatApprovalEvent {
  rpcRequestId: string;
  sessionId: string;
  approvalRequestId: string;
  command?: string;
  description?: string;
  toolName?: string;
  choices: HermesApprovalChoice[];
  allowSession?: boolean;
  allowPermanent?: boolean;
  smartDenied?: boolean;
  replayed?: boolean;
  mcp?: HermesApprovalMcpCall;
}

export interface HermesChatApprovalRespondPayload {
  rpcRequestId: string;
  choice: HermesApprovalChoice;
  all?: boolean;
}

export interface HermesChatApprovalAckPayload {
  sessionId: string;
  approvalRequestId: string;
}

/** Hermes server requests that ask the user for a credential (masked input). */
export type HermesCredentialRequestKind =
  | 'secret'
  | 'vault.unlock_prompt'
  | 'vault.save_login'
  | 'vault.code'
  | 'vault.create_login'
  | 'vault.capture_secret';

/** Sent to the renderer. Never carries a credential value. */
export interface HermesChatCredentialRequestEvent {
  rpcRequestId: string;
  sessionId: string;
  kind: HermesCredentialRequestKind;
  /** secret: the env var the value is saved as. */
  envVar?: string;
  /** secret: why the skill needs it. */
  prompt?: string;
  /** vault.unlock_prompt: password manager id and display name. */
  backend?: string;
  displayName?: string;
  /** vault.save_login / vault.code / vault.create_login / vault.capture_secret: the site the login, code or key is for. */
  origin?: string;
  site?: string;
  /** vault.code: where to find the code. */
  hint?: string;
  /** vault.create_login: the username or email the agent is signing up with. */
  identifier?: string;
  /** vault.create_login: replace the password of a login made earlier for this site. */
  regenerate?: boolean;
  /** vault.capture_secret: the environment-variable name the key is stored under. */
  name?: string;
  /** vault.capture_secret: `env` saves it to the agent's `.env`; `viewer` hands it to the client. */
  destination?: 'env' | 'viewer';
  /** vault.capture_secret: the key's last four characters, never the key. */
  last4?: string;
  /** vault.capture_secret: `env` would overwrite a value the agent already has. */
  replaces?: boolean;
  replayed?: boolean;
}

/**
 * The user's answer. Omit `value`, `login`, `createLogin` and `approve` to skip.
 * `login` is only for `vault.save_login`, `createLogin` only for `vault.create_login`, `approve`
 * only for `vault.capture_secret`, and `value` for every other kind.
 */
export interface HermesChatCredentialRespondPayload {
  rpcRequestId: string;
  value?: string;
  login?: { identifier: string; password: string };
  /** Approve a password Hermes generates, or one the user typed. */
  createLogin?: { generate: true } | { password: string };
  /** Approve storing a captured key. */
  approve?: true;
}

export interface HermesChatTurnStats {
  requestId: string;
  sessionId?: string;
  prompt?: number | null;
  generated?: number | null;
  visible?: number | null;
  ttftSec?: number | null;
  avgTps?: number | null;
}

export interface HermesChatBreakdownResult {
  success: boolean;
  breakdown?: HermesChatContextBreakdown;
  error?: string;
}

/**
 * Project row for Workbench. `kind: 'empty'` is the AssistantData library
 * (`…/projects/<slug>`); `host-folder` is an out-of-tree Mac path bind-mounted
 * at the same container path. `hermesProjectId` may be a gateway UUID or a
 * synthetic `fs:/opt/projects/<slug>` id before lazy materialize.
 */
export interface HermesProjectRecord {
  id: string;
  name: string;
  hostPath: string;
  containerPath: string;
  slug: string;
  hermesProjectId?: string | null;
  kind: 'host-folder' | 'empty';
  /** Pin or inherit; default `{ mode: 'inherit' }` on create/merge. */
  inference?: ProjectInferencePin;
  /** The coding agent may work in this project's folder (ADR 0028). Missing means off. */
  codingEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HermesProjectsListResult {
  success: boolean;
  projects: HermesProjectRecord[];
  activeId: string | null;
  connecting?: boolean;
  rpcAvailable?: boolean;
  error?: string;
}

export interface HermesProjectCreateHostPayload {
  hostPath: string;
  name?: string;
  /** Omitted ⇒ inherit (AC 17). */
  inference?: ProjectInferencePin;
  /** Main sends `hermes-projects:create-progress` events with this id while the create runs. */
  runId?: string;
  /** Let the coding agent work in the folder, in the same restart as the mount. */
  coding?: boolean;
  /**
   * When `coding` is on and a coding task is running. Omitted ⇒ the create is refused with
   * `codingBusy`, so the renderer can ask.
   */
  whenCodingBusy?: ProjectCreateWhenBusy;
}

export interface HermesProjectCreateEmptyPayload {
  name: string;
  /** Omitted ⇒ inherit (AC 17). */
  inference?: ProjectInferencePin;
}

/** The project the rail shows. It never changes an open chat (ADR 0024 §3). */
export interface HermesProjectSelectPayload {
  projectId: string | null;
}

export interface HermesProjectChangeFolderPayload {
  projectId: string;
  hostPath: string;
}

export interface HermesProjectPatchPayload {
  projectId: string;
  inference: ProjectInferencePin;
}

export interface HermesProjectResult {
  success: boolean;
  project?: HermesProjectRecord;
  projects?: HermesProjectRecord[];
  activeId?: string | null;
  connecting?: boolean;
  rpcAvailable?: boolean;
  error?: string;
  /** Set when a create with coding was refused because a coding task is running. */
  codingBusy?: CodingAgentBusy;
  /** The project was made, but the coding agent can't open its folder. */
  codingError?: string;
}

export interface HermesCompletePathPayload {
  word?: string;
  cwd?: string;
  sessionId?: string;
}

export interface HermesCompletePathItem {
  text: string;
  display?: string;
  meta?: string;
  /** When set, this item is an agent mention rather than a file path. */
  kind?: 'agent' | 'file';
  agentSlug?: string;
}

export interface HermesCompletePathResult {
  success: boolean;
  items: HermesCompletePathItem[];
  error?: string;
}

/** Mount honesty for one sources.yaml row (0013). */
export type HermesSourceVisibility = 'hub' | 'readonly' | 'writable' | 'unmounted';

export type HermesSourceRetrieval = 'files' | 'lightrag' | 'both';

export type HermesSourceNextTone = 'deny' | 'warn' | 'ok';

export interface HermesSourceSpec {
  id: string;
  path: string;
  retrieval: HermesSourceRetrieval;
  include: string[];
  exclude: string[];
}

export interface HermesSourceRow {
  id: string;
  path: string;
  hostPath: string;
  retrieval: HermesSourceRetrieval;
  visibility: HermesSourceVisibility;
  isHub: boolean;
}

export interface HermesSourceNextStep {
  tone: HermesSourceNextTone;
  title: string;
  body: string;
  commands?: string;
}

export interface HermesProjectSourcesInspect {
  projectId: string;
  stale: boolean;
  sources: HermesSourceRow[];
  nextStep?: HermesSourceNextStep;
}

export interface HermesProjectSourcesResult {
  success: boolean;
  inspect?: HermesProjectSourcesInspect;
  error?: string;
  canceled?: boolean;
}

export interface HermesProjectSourcesInspectPayload {
  projectId: string;
}

/** Add an extra folder. With `hostPath`, skip the picker (the add sheet already chose it). */
export interface HermesProjectSourcesAddPayload {
  projectId: string;
  hostPath?: string;
}

export interface HermesProjectSourcesRemovePayload {
  projectId: string;
  sourceId: string;
}

export interface HermesProjectSourcesRevealPayload {
  projectId: string;
  sourceId?: string;
}

/** Slugify a display name into a Hermes profile name (a-z, 0-9, _, -). */
export function agentSlugFromDisplayName(displayName: string): string {
  return slugify(displayName, { max: 48, fallback: 'agent' });
}
