import type {
  AgentProfile,
  ChannelPostRecord,
  ChannelRecord,
  HermesNoReply,
  HermesProjectRecord,
  HermesReplyEnding,
  SessionInferenceMark,
  SessionProjectMark,
  WritingVoiceMark,
} from '../../../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../../../shared/types/hermesChat';
import type { WritingVoiceRecord } from '../../../../shared/types/writingVoices';
import type { HermesAgentsStoreShape, SessionMeta, SpeakerEntry } from '../hermes/hermesAgentStore';

// `boundary.json` in an export folder (ADR 0070 §3): Boundary's own state for the exported
// sessions, beside the stack's `<profile>.jsonl` files and `manifest.json`. It holds chat content
// (room posts, SOUL.md text), so it is written with mode 0600.
//
// Left out because they belong to one install: `lastOpened`, `mentionsSeenAt`, `failedChats`,
// `roomSoulsSent`, `roomVoicesSent`, `orchestrator` and `webuiRefiledAt`. Pool-served turns and
// turn windows aren't in ADR 0070's list either, so a moved chat loses its pool badges.

export const BOUNDARY_HISTORY_FORMAT = 'boundary-history/1';
export const BOUNDARY_HISTORY_FILE = 'boundary.json';

/** The Hermes profile of the built-in agent and of every room. */
export const DEFAULT_PROFILE = 'default';

export interface ExportedAgent extends AgentProfile {
  /** The profile's `SOUL.md`, or null when it was missing or couldn't be read. */
  soul: string | null;
}

/** One session's slices of the agent store. Only records the session has are present. */
export interface ExportedSession {
  /** `default` for the built-in agent and rooms, else the owning agent's slug. */
  profile: string;
  meta?: SessionMeta;
  speakers?: SpeakerEntry[];
  /** Runtime ids that stand for this session (`sessionAliases` entries pointing at it). */
  aliases?: string[];
  inferenceMarks?: SessionInferenceMark[];
  writingVoiceMarks?: WritingVoiceMark[];
  projectMarks?: SessionProjectMark[];
  replyEndings?: Record<string, HermesReplyEnding>;
  replyWritingVoices?: Record<string, string>;
  promptWritingVoices?: Record<string, string>;
  noReplies?: Record<string, HermesNoReply>;
}

export type ExportedProject = Pick<HermesProjectRecord, 'id' | 'name' | 'kind' | 'hostPath'>;

export interface BoundaryHistoryFile {
  format: typeof BOUNDARY_HISTORY_FORMAT;
  createdAt: string;
  appVersion: string;
  /** The stack the history came from: the managed install or a local checkout. */
  source: { stack: 'managed' | 'local' };
  agents: ExportedAgent[];
  sessions: Record<string, ExportedSession>;
  standingDmByAgent: Record<string, string | null>;
  channels: ChannelRecord[];
  /** Room posts by the room's session id. */
  channelPosts: Record<string, ChannelPostRecord[]>;
  projects: ExportedProject[];
  writingVoices: WritingVoiceRecord[];
}

export interface BoundaryHistoryInput {
  store: HermesAgentsStoreShape;
  /** Each agent's `SOUL.md` by slug; a missing slug is written as null. */
  souls: Record<string, string | null>;
  projects: HermesProjectRecord[];
  writingVoices: WritingVoiceRecord[];
  appVersion: string;
  source: BoundaryHistoryFile['source'];
  now: Date;
}

/** Per-session maps in the store, with the field each becomes in an {@link ExportedSession}. */
const SESSION_MAPS = [
  ['sessionMeta', 'meta'],
  ['sessionSpeakers', 'speakers'],
  ['sessionInferenceMarks', 'inferenceMarks'],
  ['sessionWritingVoiceMarks', 'writingVoiceMarks'],
  ['sessionProjectMarks', 'projectMarks'],
  ['replyEndings', 'replyEndings'],
  ['replyWritingVoices', 'replyWritingVoices'],
  ['promptWritingVoices', 'promptWritingVoices'],
  ['noReplies', 'noReplies'],
] as const satisfies ReadonlyArray<readonly [keyof HermesAgentsStoreShape, keyof ExportedSession]>;

/** Every session id the store has a record for. */
export function storeSessionIds(store: HermesAgentsStoreShape): string[] {
  const ids = new Set<string>();
  for (const [key] of SESSION_MAPS) for (const id of Object.keys(store[key] ?? {})) ids.add(id);
  for (const id of Object.keys(store.channelPosts ?? {})) ids.add(id);
  for (const [runtimeId, storedId] of Object.entries(store.sessionAliases ?? {})) {
    ids.add(runtimeId);
    ids.add(storedId);
  }
  for (const channel of store.channels ?? []) if (channel.sessionId) ids.add(channel.sessionId);
  for (const id of Object.values(store.standingDmByAgent ?? {})) if (id) ids.add(id);
  return [...ids].sort();
}

/**
 * The session's Hermes profile: `default` for a room or the built-in agent, else the slug of the
 * agent that owns it, from its own record, a runtime id standing for it, or its standing DM.
 */
export function sessionProfile(store: HermesAgentsStoreShape, sessionId: string): string {
  const meta = store.sessionMeta ?? {};
  const aliases = store.sessionAliases ?? {};
  const rows = [meta[sessionId], meta[aliases[sessionId] ?? ''], ...Object.keys(aliases).filter((id) => aliases[id] === sessionId).map((id) => meta[id])];
  const isRoom = rows.some((row) => row?.channelId) || (store.channels ?? []).some((c) => c.sessionId === sessionId);
  if (isRoom) return DEFAULT_PROFILE;
  let slug = rows.find((row) => row?.agentSlug)?.agentSlug;
  if (!slug) slug = Object.keys(store.standingDmByAgent ?? {}).find((agent) => store.standingDmByAgent[agent] === sessionId);
  return !slug || slug === BUILTIN_ASSISTANT_SLUG ? DEFAULT_PROFILE : slug;
}

function exportedSession(store: HermesAgentsStoreShape, sessionId: string): ExportedSession {
  const out: ExportedSession = { profile: sessionProfile(store, sessionId) };
  const writable = out as unknown as Record<string, unknown>;
  for (const [key, field] of SESSION_MAPS) {
    const value = (store[key] as Record<string, unknown> | undefined)?.[sessionId];
    if (value !== undefined) writable[field] = value;
  }
  const aliases = Object.entries(store.sessionAliases ?? {})
    .filter(([, storedId]) => storedId === sessionId)
    .map(([runtimeId]) => runtimeId);
  if (aliases.length) out.aliases = aliases;
  return out;
}

/** Ids and names of the writing voices the sessions, replies and agents point at. */
function referencedVoices(store: HermesAgentsStoreShape): { ids: Set<string>; names: Set<string> } {
  const ids = new Set<string>();
  const names = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id) ids.add(id);
  };
  for (const agent of store.agents ?? []) {
    add(agent.chatRepliesVoiceId);
    add(agent.draftsVoiceId);
  }
  for (const meta of Object.values(store.sessionMeta ?? {})) add(meta.writingVoiceId);
  for (const marks of Object.values(store.sessionWritingVoiceMarks ?? {})) for (const mark of marks) add(mark.voiceId);
  for (const byRow of Object.values(store.promptWritingVoices ?? {})) for (const id of Object.values(byRow)) add(id);
  // Replies keep the voice's name, not its id (setReplyWritingVoice).
  for (const byRow of Object.values(store.replyWritingVoices ?? {})) for (const name of Object.values(byRow)) if (name) names.add(name);
  return { ids, names };
}

/** Builds `boundary.json` from a copy of the agent store and the records it points at. */
export function buildBoundaryHistory(input: BoundaryHistoryInput): BoundaryHistoryFile {
  const { store } = input;
  const sessions: Record<string, ExportedSession> = {};
  for (const id of storeSessionIds(store)) sessions[id] = exportedSession(store, id);

  const projectIds = new Set<string>();
  for (const meta of Object.values(store.sessionMeta ?? {})) if (meta.projectId) projectIds.add(meta.projectId);
  for (const channel of store.channels ?? []) if (channel.projectId) projectIds.add(channel.projectId);
  const projects = input.projects
    .filter((p) => projectIds.has(p.id))
    .map(({ id, name, kind, hostPath }) => ({ id, name, kind, hostPath }));

  const voices = referencedVoices(store);
  const writingVoices = input.writingVoices.filter((v) => voices.ids.has(v.id) || voices.names.has(v.name));

  return {
    format: BOUNDARY_HISTORY_FORMAT,
    createdAt: input.now.toISOString(),
    appVersion: input.appVersion,
    source: input.source,
    agents: (store.agents ?? []).map((agent) => ({ ...agent, soul: input.souls[agent.slug] ?? null })),
    sessions,
    standingDmByAgent: { ...(store.standingDmByAgent ?? {}) },
    channels: [...(store.channels ?? [])],
    channelPosts: { ...(store.channelPosts ?? {}) },
    projects,
    writingVoices,
  };
}
