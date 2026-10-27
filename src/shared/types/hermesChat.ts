import { slugify } from '../utils/slug';
import type { IpcResult } from '../ipc/result';

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
  | 'unknown';

export interface HermesNoReply {
  reason: HermesNoReplyReason;
  /** Provider or Hermes error text, when there was one. */
  error?: string;
}

/** A turn Boundary is running on Hermes (any window, including detached chats). */
export interface HermesRunningTurn {
  requestId: string;
  /** Every id the renderer may hold for the chat (runtime and stored). */
  sessionIds: string[];
  agentSlug: string | null;
  /** ISO time the turn was submitted. */
  startedAt: string;
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
  /**
   * Continue a stopped reply: submit a hidden continue instruction instead of a user turn.
   * Hermes kept the partial, so the new reply picks up from it. Gateway DMs only.
   */
  continue?: boolean;
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
  | 'apply-failed'
  | 'rewind-stale'
  | 'rewind-unsupported';

export interface HermesChatStartResult {
  success: boolean;
  requestId: string;
  sessionId?: string;
  error?: string;
  errorCode?: HermesChatStartErrorCode;
  /** Channel send with no member @ — persisted as a post, no model turn. */
  posted?: boolean;
}

export interface HermesChatCancelPayload {
  requestId: string;
  /** Stop the chat's running turn whatever its request id (a window reopened mid-turn). */
  sessionId?: string;
  /** Why the run is being cut short; recorded on the partial reply. Defaults to `stopped`. */
  reason?: HermesReplyEnding;
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
}

export interface HermesChatEndEvent {
  requestId: string;
  finishReason?: string;
  sessionId?: string;
  /** Set when the turn ended without any reply text. */
  noReply?: HermesNoReply;
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
  /** New standing DM opened after create. */
  thread?: HermesChatThreadSummary;
  /** Honest wait while the profile gateway starts. */
  starting?: boolean;
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
  /** Phase 4 enforcement; Phase 3 may persist/render disabled only. */
  privacyLocalOnly?: boolean;
}

export interface SessionInferenceOverride {
  provider: ChatInferenceProvider;
  modelId: string;
}

export interface SessionInferenceMark {
  id: string;
  at: string;
  kind: 'switched';
  provider: ChatInferenceProvider;
  modelId: string;
}

export interface ResolvedSessionInference {
  slot: import('./onboarding').InferenceSlotId;
  modelId: string;
  providerDisplayName: string;
  provenance: InferenceProvenance;
  configured: boolean;
  health?: import('./onboarding').LlmSlotHealth;
  needsRestart: boolean;
}

export interface HermesSessionInferencePayload {
  sessionId: string;
}

export interface HermesSessionInferenceSetPayload {
  sessionId: string;
  provider: ChatInferenceProvider;
  modelId: string;
}

export interface HermesSessionInferenceResult {
  success: boolean;
  override: SessionInferenceOverride | null;
  resolved: ResolvedSessionInference | null;
  marks: SessionInferenceMark[];
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
  | 'vault.code';

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
  /** vault.save_login / vault.code: the site the login or code is for. */
  origin?: string;
  site?: string;
  /** vault.code: where to find the code. */
  hint?: string;
  replayed?: boolean;
}

/**
 * The user's answer. Omit `value` and `login` to skip.
 * `login` is only for `vault.save_login`; `value` for every other kind.
 */
export interface HermesChatCredentialRespondPayload {
  rpcRequestId: string;
  value?: string;
  login?: { identifier: string; password: string };
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
