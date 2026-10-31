import Store from 'electron-store';
import { randomUUID } from 'node:crypto';
import type {
  AgentProfile,
  ChannelPostRecord,
  ChannelRecord,
  ChatInferenceProvider,
  HermesChatBranchInfo,
  HermesChatDelivery,
  HermesFailedChat,
  HermesFailedTurn,
  HermesLastOpened,
  HermesNoReply,
  HermesReplyEnding,
  SessionInferenceMark,
  SessionInferenceOverride,
  SessionProjectMark,
} from '../../../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../../../shared/types/hermesChat';
import { BUILTIN_AGENT_FALLBACK } from '../../../../shared/hermesAgentIdentity';
import { newestFirst } from '../../../../shared/utils/sort';
import {
  type AssistantStackIdentity,
  activeAssistantStackIdentity,
  hermesAgentsStoreName,
} from '../assistantStackIdentity';
import { readStoreFromMemory } from '../../storeMemoryCache';

interface SessionMeta {
  agentSlug: string;
  channelId?: string;
  inference?: SessionInferenceOverride;
  /** Set when the session was branched from another chat. */
  branch?: HermesChatBranchInfo;
  /**
   * ADR 0024: the project the chat lives in (a DM: the folder it works in). Null is No
   * project; absent means not filed yet, which the chat list resolves once from its cwd.
   */
  projectId?: string | null;
}

/** Assistant-message ordinal → agent that spoke it (per session). */
interface SpeakerEntry {
  ordinal: number;
  agentSlug: string;
}

interface HermesAgentsStoreShape {
  /** The stack root these records belong to (informational; the file name is the key). */
  stackRoot?: string;
  agents: AgentProfile[];
  /** Standing DM session id per personality. The built-in has chats, not a DM (ADR 0023). */
  standingDmByAgent: Record<string, string | null>;
  /** Session → agent ownership (Hermes chats, DMs, side chats) + optional channel link. */
  sessionMeta: Record<string, SessionMeta>;
  channels: ChannelRecord[];
  lastOpened: HermesLastOpened | null;
  /** Ordered assistant speakers per session (survives reload). */
  sessionSpeakers: Record<string, SpeakerEntry[]>;
  /** Durable channel user lines (0009 posts + wakes). */
  channelPosts: Record<string, ChannelPostRecord[]>;
  /** Switch markers shown in the transcript without entering Hermes history. */
  sessionInferenceMarks: Record<string, SessionInferenceMark[]>;
  /** Project moves and DM folder changes, shown in the transcript only (ADR 0024). */
  sessionProjectMarks: Record<string, SessionProjectMark[]>;
  /**
   * How cut-short replies ended, by session and Hermes row id. Hermes saves the partial
   * text but not why it stopped, so the Stopped / Interrupted markers survive a reload.
   */
  replyEndings: Record<string, Record<string, HermesReplyEnding>>;
  /** Why a reply never came, by session and the unanswered user row id. */
  noReplies: Record<string, Record<string, HermesNoReply>>;
  /** Failed sends Hermes holds nothing for, by stored session id or Boundary's local id. */
  failedChats?: Record<string, HermesFailedChat>;
  /** Mentions: replies newer than this are unseen (ADR 0023 §6). Null until first read. */
  mentionsSeenAt: string | null;
  /**
   * Set once WebUI chats filed under No project before Boundary read WebUI's folder have been
   * filed again from it (ADR 0024 amendment). Absent until that pass has run.
   */
  webuiRefiledAt?: string;
  /**
   * The orchestrator agent Boundary set up (its profile slug) and whether its profile has
   * the kanban toolset yet. Absent until it has been created.
   */
  orchestrator?: OrchestratorRecord;
  /**
   * Runtime → stored Hermes session ids, so an id the renderer or a record kept from an earlier
   * run still resolves to its session. Oldest entries drop past SESSION_ALIAS_LIMIT.
   */
  sessionAliases?: Record<string, string>;
  /**
   * Per room session, the hash of the SOUL.md each agent last had sent there as turn context.
   * Hermes keeps turn context in the session's history, so it is sent again only when the
   * file changes. Not moved with the room: a new session hasn't seen it.
   */
  roomSoulsSent?: Record<string, Record<string, string>>;
}

export interface OrchestratorRecord {
  slug: string;
  kanbanEnabled: boolean;
}

const BUILTIN_ASSISTANT: AgentProfile = BUILTIN_AGENT_FALLBACK;

const STORE_DEFAULTS: HermesAgentsStoreShape = {
  agents: [BUILTIN_ASSISTANT],
  standingDmByAgent: {},
  sessionMeta: {},
  channels: [],
  lastOpened: null,
  sessionSpeakers: {},
  channelPosts: {},
  sessionInferenceMarks: {},
  sessionProjectMarks: {},
  replyEndings: {},
  noReplies: {},
  mentionsSeenAt: null,
};

const stores = new Map<string, Store<HermesAgentsStoreShape>>();
/** The identity object is reused while it is unchanged, so its store name is too. */
let named: { identity: AssistantStackIdentity; name: string } | null = null;

/**
 * The records for the stack this session talks to (one file per stack; see
 * assistantStackIdentity).
 */
function store(): Store<HermesAgentsStoreShape> {
  const identity = activeAssistantStackIdentity();
  if (named?.identity !== identity) named = { identity, name: hermesAgentsStoreName(identity) };
  const { name } = named;
  let opened = stores.get(name);
  if (!opened) {
    // Read from memory: the chat list reads this store several times per chat.
    opened = readStoreFromMemory(
      new Store<HermesAgentsStoreShape>({ name, defaults: { ...STORE_DEFAULTS } })
    );
    opened.set('stackRoot', identity.root);
    stores.set(name, opened);
  }
  return opened;
}

function ensureBuiltin(): AgentProfile[] {
  const agents = store().get('agents') ?? [];
  if (!agents.some((a) => a.slug === BUILTIN_ASSISTANT_SLUG)) {
    const next = [BUILTIN_ASSISTANT, ...agents];
    store().set('agents', next);
    return next;
  }
  return agents;
}

export function listStoredAgents(): AgentProfile[] {
  return ensureBuiltin();
}

export function getStoredAgent(slug: string): AgentProfile | null {
  return listStoredAgents().find((a) => a.slug === slug) ?? null;
}

export function upsertStoredAgent(agent: AgentProfile): void {
  const agents = listStoredAgents().filter((a) => a.slug !== agent.slug);
  // Built-in agent always first.
  if (agent.builtIn || agent.slug === BUILTIN_ASSISTANT_SLUG) {
    store().set('agents', [agent, ...agents.filter((a) => a.slug !== BUILTIN_ASSISTANT_SLUG)]);
  } else {
    const builtin = agents.find((a) => a.slug === BUILTIN_ASSISTANT_SLUG) ?? BUILTIN_ASSISTANT;
    const rest = agents.filter((a) => a.slug !== BUILTIN_ASSISTANT_SLUG);
    store().set('agents', [builtin, ...rest.filter((a) => a.slug !== agent.slug), agent]);
  }
  if (agent.slug === BUILTIN_ASSISTANT_SLUG) return;
  const standing = getStandingDmMap();
  if (!(agent.slug in standing)) {
    standing[agent.slug] = null;
    store().set('standingDmByAgent', standing);
  }
}

/** Standing DMs by personality. */
export function getStandingDmMap(): Record<string, string | null> {
  return { ...(store().get('standingDmByAgent') ?? {}) };
}

export function getStandingDmSessionId(agentSlug: string): string | null {
  return getStandingDmMap()[agentSlug] ?? null;
}

export function setStandingDmSessionId(agentSlug: string, sessionId: string | null): void {
  if (agentSlug === BUILTIN_ASSISTANT_SLUG) return;
  const map = getStandingDmMap();
  map[agentSlug] = sessionId;
  store().set('standingDmByAgent', map);
}

export function getSessionAgentSlug(sessionId: string): string | null {
  for (const row of metaRowsFor(sessionId)) {
    if (row.agentSlug) return row.agentSlug;
  }
  return null;
}

/**
 * A session's records: its own, then those kept under runtime ids that stand for it (newest
 * first). A turn can be recorded under the runtime id it ran on before its stored id is known.
 */
function metaRowsFor(sessionId: string): SessionMeta[] {
  const meta = store().get('sessionMeta') ?? {};
  const rows = [meta[sessionId]];
  const aliases = store().get('sessionAliases') ?? {};
  const runtimeIds = Object.keys(aliases).filter((id) => aliases[id] === sessionId);
  for (const id of runtimeIds.reverse()) rows.push(meta[id]);
  return rows.filter((row): row is SessionMeta => Boolean(row));
}

export function getSessionChannelId(sessionId: string): string | null {
  return store().get('sessionMeta')?.[sessionId]?.channelId ?? null;
}

export function setSessionAgentSlug(sessionId: string, agentSlug: string): void {
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  const prior = meta[sessionId];
  meta[sessionId] = {
    ...prior,
    agentSlug,
  };
  store().set('sessionMeta', meta);
}

/** Merges `fields` into a session's meta, keeping its agent slug (the built-in agent's when unset). */
function updateSessionMeta(sessionId: string, fields: Partial<SessionMeta>): void {
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  const prior = meta[sessionId];
  meta[sessionId] = {
    ...prior,
    agentSlug: prior?.agentSlug ?? getSessionAgentSlug(sessionId) ?? BUILTIN_ASSISTANT_SLUG,
    ...fields,
  };
  store().set('sessionMeta', meta);
}

export function setSessionChannelId(sessionId: string, channelId: string): void {
  updateSessionMeta(sessionId, { channelId });
}

export function clearSessionChannelId(sessionId: string): void {
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  const prior = meta[sessionId];
  if (!prior) return;
  const { channelId: _drop, ...rest } = prior;
  meta[sessionId] = rest;
  store().set('sessionMeta', meta);
}

/** The stored project; `undefined` when the session has never been filed. */
export function getSessionProjectId(sessionId: string): string | null | undefined {
  const row = metaRowsFor(sessionId).find((r) => 'projectId' in r);
  if (!row) return undefined;
  return row.projectId ?? null;
}

/** File several sessions in one write (the chat list's one-time filing, Move). */
export function setSessionProjectIds(entries: Record<string, string | null>): void {
  const ids = Object.keys(entries);
  if (ids.length === 0) return;
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  for (const id of ids) {
    const prior = meta[id];
    meta[id] = {
      ...prior,
      agentSlug: prior?.agentSlug ?? getSessionAgentSlug(id) ?? BUILTIN_ASSISTANT_SLUG,
      projectId: entries[id],
    };
  }
  store().set('sessionMeta', meta);
}

export function listSessionProjectMarks(sessionId: string): SessionProjectMark[] {
  return [...(store().get('sessionProjectMarks')?.[sessionId] ?? [])];
}

export function appendSessionProjectMark(
  sessionId: string,
  input: Omit<SessionProjectMark, 'id' | 'at'>
): SessionProjectMark {
  const mark: SessionProjectMark = { id: randomUUID(), at: new Date().toISOString(), ...input };
  const all = { ...(store().get('sessionProjectMarks') ?? {}) };
  all[sessionId] = [...(all[sessionId] ?? []), mark];
  store().set('sessionProjectMarks', all);
  return mark;
}

/** Undo drops the move's mark, wherever the session's marks are kept. */
export function removeSessionProjectMark(markId: string): void {
  const all = { ...(store().get('sessionProjectMarks') ?? {}) };
  let changed = false;
  for (const [id, marks] of Object.entries(all)) {
    const kept = marks.filter((m) => m.id !== markId);
    if (kept.length !== marks.length) {
      all[id] = kept;
      changed = true;
    }
  }
  if (changed) store().set('sessionProjectMarks', all);
}

export function getSessionInference(sessionId: string): SessionInferenceOverride | null {
  return store().get('sessionMeta')?.[sessionId]?.inference ?? null;
}

export function setSessionInference(
  sessionId: string,
  inference: SessionInferenceOverride
): void {
  updateSessionMeta(sessionId, {
    inference: {
      provider: inference.provider,
      modelId: inference.modelId.trim(),
      ...(inference.fallbacks?.length ? { fallbacks: inference.fallbacks } : {}),
    },
  });
}

export function clearSessionInference(sessionId: string): void {
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  const prior = meta[sessionId];
  if (!prior?.inference) return;
  const { inference: _drop, ...rest } = prior;
  meta[sessionId] = rest;
  store().set('sessionMeta', meta);
}

export function clearSessionInferenceForProvider(provider: ChatInferenceProvider): void {
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  let changed = false;
  for (const [id, row] of Object.entries(meta)) {
    if (row.inference?.provider !== provider) continue;
    const { inference: _drop, ...rest } = row;
    meta[id] = rest;
    changed = true;
  }
  if (changed) store().set('sessionMeta', meta);
}

/**
 * Point chat overrides for a provider at its newly saved model. The chip only offers each
 * provider's saved model, so an override means "this provider", not a frozen model id.
 */
export function retargetSessionInferenceModel(
  provider: ChatInferenceProvider,
  modelId: string
): void {
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  let changed = false;
  for (const [id, row] of Object.entries(meta)) {
    if (row.inference?.provider !== provider || row.inference.modelId === modelId) continue;
    meta[id] = { ...row, inference: { ...row.inference, modelId } };
    changed = true;
  }
  if (changed) store().set('sessionMeta', meta);
}

export function listSessionInferenceMarks(sessionId: string): SessionInferenceMark[] {
  return [...(store().get('sessionInferenceMarks')?.[sessionId] ?? [])];
}

export function appendSessionInferenceMark(
  sessionId: string,
  input: Pick<SessionInferenceMark, 'kind' | 'provider' | 'modelId' | 'sharedBy'>,
  at: Date = new Date()
): SessionInferenceMark {
  const mark: SessionInferenceMark = {
    id: randomUUID(),
    at: at.toISOString(),
    kind: input.kind,
    provider: input.provider,
    modelId: input.modelId,
    ...(input.sharedBy ? { sharedBy: input.sharedBy } : {}),
  };
  const all = { ...(store().get('sessionInferenceMarks') ?? {}) };
  all[sessionId] = [...(all[sessionId] ?? []), mark];
  store().set('sessionInferenceMarks', all);
  return mark;
}

export function getReplyEndings(sessionId: string): Record<string, HermesReplyEnding> {
  return { ...(store().get('replyEndings')?.[sessionId] ?? {}) };
}

export function setReplyEnding(sessionId: string, rowId: number, ending: HermesReplyEnding): void {
  const all = { ...(store().get('replyEndings') ?? {}) };
  all[sessionId] = { ...(all[sessionId] ?? {}), [String(rowId)]: ending };
  store().set('replyEndings', all);
}

export function getNoReplies(sessionId: string): Record<string, HermesNoReply> {
  return { ...(store().get('noReplies')?.[sessionId] ?? {}) };
}

export function setNoReply(sessionId: string, userRowId: number, noReply: HermesNoReply): void {
  const all = { ...(store().get('noReplies') ?? {}) };
  all[sessionId] = { ...(all[sessionId] ?? {}), [String(userRowId)]: noReply };
  store().set('noReplies', all);
}

export function getSessionBranch(sessionId: string): HermesChatBranchInfo | null {
  return store().get('sessionMeta')?.[sessionId]?.branch ?? null;
}

export function setSessionBranch(sessionId: string, branch: HermesChatBranchInfo): void {
  updateSessionMeta(sessionId, { branch });
}

/** A branch keeps its parent's chat override; unlike migrate, the parent keeps it too. */
export function copySessionInference(fromId: string, toId: string): void {
  const inference = getSessionInference(fromId);
  if (inference) setSessionInference(toId, inference);
}

/**
 * A chat's session id changed (a resume, an offline placeholder replaced): carry what belongs
 * to the chat, not the id. That is its inference override and its project (ADR 0024), with
 * their transcript marks.
 */
/** Runtime ids and stored ids of one session share a record. */
function failedChatKey(sessionId: string): string {
  return store().get('sessionAliases')?.[sessionId] ?? sessionId;
}

export function listFailedChats(): Record<string, HermesFailedChat> {
  return store().get('failedChats') ?? {};
}

export function getFailedChat(sessionId: string): HermesFailedChat | null {
  return listFailedChats()[failedChatKey(sessionId)] ?? null;
}

/** Adds a failed send to its chat's record, starting the record from `chat` if it has none. */
export function addFailedTurn(
  sessionId: string,
  chat: Omit<HermesFailedChat, 'turns'>,
  turn: Omit<HermesFailedTurn, 'id'>
): void {
  const key = failedChatKey(sessionId);
  const chats = listFailedChats();
  const prior = chats[key] ?? { ...chat, turns: [] };
  store().set('failedChats', {
    ...chats,
    [key]: { ...prior, turns: [...prior.turns, { id: randomUUID(), ...turn }] },
  });
}

/**
 * Retry of the chat's latest failed send failed too: its error becomes the new one, in place.
 * False when that send isn't the latest one on record, so nothing changed.
 */
export function replaceFailedTurn(
  sessionId: string,
  text: string,
  failure: Pick<HermesFailedTurn, 'noReply' | 'errorCode'>
): boolean {
  const key = failedChatKey(sessionId);
  const chats = listFailedChats();
  const prior = chats[key];
  const last = prior?.turns.at(-1);
  if (!prior || last?.text !== text) return false;
  const { errorCode: _old, ...kept } = last;
  store().set('failedChats', {
    ...chats,
    [key]: { ...prior, turns: [...prior.turns.slice(0, -1), { ...kept, ...failure }] },
  });
  return true;
}

export function deleteFailedChat(sessionId: string): void {
  const key = failedChatKey(sessionId);
  const { [key]: _deleted, ...chats } = listFailedChats();
  store().set('failedChats', chats);
  const { [key]: _meta, ...meta } = store().get('sessionMeta') ?? {};
  store().set('sessionMeta', meta);
}

/** The session id changed: the record follows, and the chat now has a Hermes session. */
function moveFailedChat(fromId: string, toId: string): void {
  const fromKey = failedChatKey(fromId);
  const toKey = failedChatKey(toId);
  const chats = listFailedChats();
  const moving = chats[fromKey];
  if (!moving || fromKey === toKey) return;
  const { [fromKey]: _moved, ...rest } = chats;
  const { local: _local, ...kept } = moving;
  const turns = [...(chats[toKey]?.turns ?? []), ...moving.turns].sort((a, b) =>
    a.at.localeCompare(b.at)
  );
  store().set('failedChats', { ...rest, [toKey]: { ...kept, ...chats[toKey], turns } });
}

export function migrateSessionInference(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  moveFailedChat(fromId, toId);
  const meta = { ...(store().get('sessionMeta') ?? {}) };
  const from = meta[fromId];
  const to = meta[toId];
  const carriesProject = Boolean(from && 'projectId' in from) && !(to && 'projectId' in to);
  if (from?.inference || carriesProject) {
    meta[toId] = {
      ...(to ?? { agentSlug: from!.agentSlug ?? BUILTIN_ASSISTANT_SLUG }),
      ...(from!.inference ? { inference: from!.inference } : {}),
      ...(carriesProject ? { projectId: from!.projectId ?? null } : {}),
    };
    store().set('sessionMeta', meta);
  }
  const projectMarks = { ...(store().get('sessionProjectMarks') ?? {}) };
  const fromProjectMarks = projectMarks[fromId] ?? [];
  if (fromProjectMarks.length > 0) {
    const seenProject = new Set((projectMarks[toId] ?? []).map((m) => m.id));
    projectMarks[toId] = [
      ...(projectMarks[toId] ?? []),
      ...fromProjectMarks.filter((m) => !seenProject.has(m.id)),
    ];
    delete projectMarks[fromId];
    store().set('sessionProjectMarks', projectMarks);
  }
  const marks = { ...(store().get('sessionInferenceMarks') ?? {}) };
  const fromMarks = marks[fromId] ?? [];
  if (fromMarks.length === 0) return;
  const seen = new Set((marks[toId] ?? []).map((m) => m.id));
  marks[toId] = [...(marks[toId] ?? []), ...fromMarks.filter((m) => !seen.has(m.id))];
  delete marks[fromId];
  store().set('sessionInferenceMarks', marks);
}

export function listStoredChannels(): ChannelRecord[] {
  return [...(store().get('channels') ?? [])].sort(newestFirst);
}

export function getStoredChannel(channelId: string): ChannelRecord | null {
  return listStoredChannels().find((c) => c.id === channelId) ?? null;
}

export function getChannelBySessionId(sessionId: string): ChannelRecord | null {
  return listStoredChannels().find((c) => c.sessionId === sessionId) ?? null;
}

export function upsertStoredChannel(channel: ChannelRecord): void {
  const channels = listStoredChannels().filter((c) => c.id !== channel.id);
  store().set('channels', [...channels, channel]);
}

export function deleteStoredChannel(channelId: string): void {
  store().set('channels', listStoredChannels().filter((c) => c.id !== channelId));
}

export function getLastOpened(): HermesLastOpened | null {
  return store().get('lastOpened') ?? null;
}

export function setLastOpened(value: HermesLastOpened | null): void {
  store().set('lastOpened', value);
}

export function getSessionSpeakers(sessionId: string): SpeakerEntry[] {
  return [...(store().get('sessionSpeakers')?.[sessionId] ?? [])];
}

export function appendSessionSpeaker(sessionId: string, agentSlug: string): number {
  const all = { ...(store().get('sessionSpeakers') ?? {}) };
  const list = [...(all[sessionId] ?? [])];
  const ordinal = list.length;
  list.push({ ordinal, agentSlug });
  all[sessionId] = list;
  store().set('sessionSpeakers', all);
  return ordinal;
}

/**
 * Move speaker records from one session key to another, appended after what is there and
 * renumbered, so ordinals keep matching the stored transcript's assistant turns in order.
 */
export function migrateSessionSpeakers(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  const all = { ...(store().get('sessionSpeakers') ?? {}) };
  const from = all[fromId] ?? [];
  if (from.length === 0) return;
  const merged = [...(all[toId] ?? []), ...from].map((entry, ordinal) => ({
    ordinal,
    agentSlug: entry.agentSlug,
  }));
  all[toId] = merged;
  delete all[fromId];
  store().set('sessionSpeakers', all);
}

export function getMentionsSeenAt(): string | null {
  return store().get('mentionsSeenAt') ?? null;
}

export function setMentionsSeenAt(at: string): void {
  store().set('mentionsSeenAt', at);
}

export function getWebuiRefiledAt(): string | null {
  return store().get('webuiRefiledAt') ?? null;
}

export function setWebuiRefiledAt(at: string): void {
  store().set('webuiRefiledAt', at);
}

const SESSION_ALIAS_LIMIT = 500;

export function getStoredSessionAlias(runtimeId: string): string | null {
  return store().get('sessionAliases')?.[runtimeId] ?? null;
}

export function setStoredSessionAlias(runtimeId: string, storedId: string): void {
  const aliases = store().get('sessionAliases') ?? {};
  if (aliases[runtimeId] === storedId) return;
  const next = { ...aliases, [runtimeId]: storedId };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - SESSION_ALIAS_LIMIT))) delete next[key];
  store().set('sessionAliases', next);
}

export function getOrchestratorRecord(): OrchestratorRecord | null {
  return store().get('orchestrator') ?? null;
}

export function setOrchestratorRecord(record: OrchestratorRecord): void {
  store().set('orchestrator', record);
}

/** Every session id Boundary has linked to a room, in the order they were recorded. */
export function listSessionsForChannel(channelId: string): string[] {
  const meta = store().get('sessionMeta') ?? {};
  return Object.entries(meta)
    .filter(([, value]) => value.channelId === channelId)
    .map(([id]) => id);
}

export function listChannelPosts(sessionId: string): ChannelPostRecord[] {
  return [...(store().get('channelPosts')?.[sessionId] ?? [])];
}

export function appendChannelPost(
  sessionId: string,
  input: { content: string; delivery: HermesChatDelivery }
): ChannelPostRecord {
  const post: ChannelPostRecord = {
    id: randomUUID(),
    content: input.content,
    createdAt: new Date().toISOString(),
    delivery: input.delivery,
  };
  const all = { ...(store().get('channelPosts') ?? {}) };
  const current = listChannelPosts(sessionId);
  all[sessionId] = [...current, post];
  store().set('channelPosts', all);
  return post;
}

export function consumeUnconsumedPosted(sessionId: string): ChannelPostRecord[] {
  const all = { ...(store().get('channelPosts') ?? {}) };
  const list = listChannelPosts(sessionId);
  const now = new Date().toISOString();
  const unread = list.filter((p) => p.delivery === 'posted' && !p.consumedAt);
  if (unread.length === 0) return [];
  const unreadIds = new Set(unread.map((p) => p.id));
  all[sessionId] = list.map((p) =>
    unreadIds.has(p.id) ? { ...p, consumedAt: now } : p
  );
  store().set('channelPosts', all);
  return unread;
}

export function migrateChannelPosts(fromId: string, toId: string): void {
  if (!fromId || !toId || fromId === toId) return;
  const all = { ...(store().get('channelPosts') ?? {}) };
  const from = listChannelPosts(fromId);
  if (from.length === 0) return;
  const seen = new Set(listChannelPosts(toId).map((p) => p.id));
  // Keep the room in time order however the two lists interleave.
  const merged = [...listChannelPosts(toId), ...from.filter((p) => !seen.has(p.id))].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
  );
  all[toId] = merged;
  delete all[fromId];
  store().set('channelPosts', all);
}

export function setChannelPostAssistantCount(
  sessionId: string,
  postId: string,
  assistantCount: number
): void {
  const all = { ...(store().get('channelPosts') ?? {}) };
  const list = listChannelPosts(sessionId);
  all[sessionId] = list.map((p) =>
    p.id === postId ? { ...p, assistantCount } : p
  );
  store().set('channelPosts', all);
}

export function getRoomSoulSent(roomKey: string, agentSlug: string): string | null {
  return store().get('roomSoulsSent')?.[roomKey]?.[agentSlug] ?? null;
}

export function setRoomSoulSent(roomKey: string, agentSlug: string, hash: string): void {
  const all = { ...(store().get('roomSoulsSent') ?? {}) };
  all[roomKey] = { ...(all[roomKey] ?? {}), [agentSlug]: hash };
  store().set('roomSoulsSent', all);
}

/** Test helper — wipe store state. */
export function resetHermesAgentsStoreForTests(
  agents: AgentProfile[] = [BUILTIN_ASSISTANT],
  standingDmByAgent: Record<string, string | null> = {}
): void {
  store().set('agents', agents);
  store().set('standingDmByAgent', standingDmByAgent);
  store().set('sessionMeta', {});
  store().set('failedChats', {});
  store().set('channels', []);
  store().set('lastOpened', null);
  store().set('sessionSpeakers', {});
  store().set('channelPosts', {});
  store().set('sessionInferenceMarks', {});
  store().set('sessionProjectMarks', {});
  store().set('replyEndings', {});
  store().set('noReplies', {});
  store().set('mentionsSeenAt', null);
  store().delete('webuiRefiledAt');
  store().delete('roomSoulsSent');
}
