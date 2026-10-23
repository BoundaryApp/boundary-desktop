import { randomUUID } from 'node:crypto';
import { parseMemberMentions } from '../../../../shared/hermesMentions';
import { toUnixSeconds } from '../../../../shared/messageTime';
import type {
  ChannelPostRecord,
  ChannelRecord,
  HermesChannelAddMemberPayload,
  HermesChannelAddMemberResult,
  HermesChannelCreatePayload,
  HermesChannelCreateResult,
  HermesChannelDeletePayload,
  HermesChannelDeleteResult,
  HermesChannelRenamePayload,
  HermesChannelRenameResult,
  HermesChannelsListResult,
  HermesChatMessage,
  HermesChatThreadSummary,
  HermesMakeChannelFromChatPayload,
  HermesMakeChannelFromChatResult,
  HermesSetLastOpenedPayload,
  HermesSetLastOpenedResult,
} from '../../../../shared/types/hermesChat';
import {
  agentSlugFromDisplayName,
  BUILTIN_ASSISTANT_SLUG,
} from '../../../../shared/types/hermesChat';

export { parseMemberMentions };
import { getHermesGatewaySession } from './hermesGatewaySession';
import {
  clearSessionChannelId,
  deleteStoredChannel,
  getChannelBySessionId,
  getLastOpened,
  getSessionAgentSlug,
  getSessionChannelId,
  getSessionProjectId,
  getStandingDmMap,
  getStoredAgent,
  getStoredChannel,
  listSessionsForChannel,
  listChannelPosts,
  listStoredAgents,
  listStoredChannels,
  migrateChannelPosts,
  migrateSessionSpeakers,
  setLastOpened,
  setSessionAgentSlug,
  setSessionChannelId,
  setSessionProjectIds,
  setStandingDmSessionId,
  upsertStoredChannel,
} from './hermesAgentStore';

/** A slug no other room has; `exceptId` lets a renamed room keep its own. */
function uniqueChannelSlug(base: string, exceptId?: string): string {
  let slug = base || 'channel';
  let n = 2;
  const existing = new Set(
    listStoredChannels()
      .filter((c) => c.id !== exceptId)
      .map((c) => c.slug)
  );
  while (existing.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function normalizeMemberSlugs(slugs: string[] | undefined): string[] {
  const agents = new Set(listStoredAgents().map((a) => a.slug));
  const out: string[] = [];
  for (const raw of slugs ?? []) {
    const slug = raw.trim();
    if (!slug || !agents.has(slug)) continue;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export function listHermesChannels(): HermesChannelsListResult {
  try {
    return {
      success: true,
      channels: listStoredChannels(),
      lastOpened: getLastOpened(),
    };
  } catch (err) {
    return {
      success: false,
      channels: [],
      lastOpened: getLastOpened(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function setHermesLastOpened(
  payload: HermesSetLastOpenedPayload
): HermesSetLastOpenedResult {
  const kind = payload.kind;
  const id = payload.id?.trim();
  if (!id || (kind !== 'hermes' && kind !== 'dm' && kind !== 'channel')) {
    return { success: false, error: 'Invalid last-opened payload.' };
  }
  const value = { kind, id };
  setLastOpened(value);
  return { success: true, lastOpened: value };
}

export async function createHermesChannel(
  payload: HermesChannelCreatePayload
): Promise<HermesChannelCreateResult> {
  const title = payload.title.trim().replace(/^#/, '');
  if (!title) {
    return { success: false, error: 'Channel name is required.' };
  }
  const baseSlug = agentSlugFromDisplayName(payload.slug?.trim() || title);
  const slug = uniqueChannelSlug(baseSlug);
  const memberSlugs = normalizeMemberSlugs(payload.memberSlugs);
  const now = new Date().toISOString();
  const channelId = randomUUID();

  let sessionId: string;
  let runtimeId: string;
  try {
    const gateway = getHermesGatewaySession();
    runtimeId = await gateway.createSessionWithSeed({
      title: `#${slug}`,
      // Shared room transcript — do not bind to a single agent profile.
      profile: null,
    });
    // Keep the stored id: a runtime id dies when Hermes restarts ("Session not found").
    sessionId = gateway.storedSessionId(runtimeId);
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? `Could not create channel session: ${err.message}`
          : 'Could not create channel session.',
    };
  }

  const channel: ChannelRecord = {
    id: channelId,
    slug,
    title: title.startsWith('#') ? title.slice(1) : title,
    sessionId,
    memberSlugs,
    projectId: payload.projectId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  upsertStoredChannel(channel);
  for (const key of new Set([sessionId, runtimeId])) {
    setSessionChannelId(key, channelId);
    // Channels are not DMs — clear any accidental standing pin for this session.
    setSessionAgentSlug(key, BUILTIN_ASSISTANT_SLUG);
  }
  setLastOpened({ kind: 'channel', id: channelId });

  const thread: HermesChatThreadSummary = {
    id: sessionId,
    title: `#${slug}`,
    updatedAt: now,
    source: 'boundary',
    kind: 'channel',
    channelId,
    channelSlug: slug,
    agentSlug: BUILTIN_ASSISTANT_SLUG,
  };

  return { success: true, channel, thread };
}

export function addHermesChannelMember(
  payload: HermesChannelAddMemberPayload
): HermesChannelAddMemberResult {
  const channelId = payload.channelId?.trim();
  const agentSlug = payload.agentSlug?.trim();
  if (!channelId || !agentSlug) {
    return { success: false, error: 'Missing channel or agent.' };
  }
  const channel = getStoredChannel(channelId);
  if (!channel) {
    return { success: false, error: 'Channel not found.' };
  }
  if (!getStoredAgent(agentSlug)) {
    return { success: false, error: 'Agent not found.' };
  }
  if (channel.memberSlugs.includes(agentSlug)) {
    return { success: true, channel };
  }
  const next: ChannelRecord = {
    ...channel,
    memberSlugs: [...channel.memberSlugs, agentSlug],
    updatedAt: new Date().toISOString(),
  };
  upsertStoredChannel(next);
  return { success: true, channel: next };
}

/** Take an agent out of a room. It can no longer be woken there (0008); the room stays. */
export function removeHermesChannelMember(
  payload: HermesChannelAddMemberPayload
): HermesChannelAddMemberResult {
  const channelId = payload.channelId?.trim();
  const agentSlug = payload.agentSlug?.trim();
  if (!channelId || !agentSlug) {
    return { success: false, error: 'Missing channel or agent.' };
  }
  const channel = getStoredChannel(channelId);
  if (!channel) {
    return { success: false, error: 'Channel not found.' };
  }
  if (!channel.memberSlugs.includes(agentSlug)) {
    return { success: true, channel };
  }
  const next: ChannelRecord = {
    ...channel,
    memberSlugs: channel.memberSlugs.filter((slug) => slug !== agentSlug),
    updatedAt: new Date().toISOString(),
  };
  upsertStoredChannel(next);
  return { success: true, channel: next };
}

/**
 * Rename a room (ADR 0010 §3). The slug is the one given or made from the name, kept
 * unique. Hermes's session is retitled `#slug` too, so other clients and session repair
 * (which matches rooms by that title) still find it; the rail names rooms from the record,
 * so a failed retitle only leaves Hermes's own list behind.
 */
export async function renameHermesChannel(
  payload: HermesChannelRenamePayload
): Promise<HermesChannelRenameResult> {
  const channel = getStoredChannel(payload.channelId?.trim() ?? '');
  if (!channel) {
    return { success: false, error: 'Channel not found.' };
  }
  const title = (payload.title ?? '').trim().replace(/^#/, '').trim();
  if (!title) {
    return { success: false, error: 'Channel name is required.' };
  }
  const slug = uniqueChannelSlug(
    agentSlugFromDisplayName(payload.slug?.trim() || title),
    channel.id
  );
  if (title === channel.title && slug === channel.slug) {
    return { success: true, channel };
  }
  const next: ChannelRecord = { ...channel, title, slug, updatedAt: new Date().toISOString() };
  upsertStoredChannel(next);
  if (slug !== channel.slug) {
    try {
      await getHermesGatewaySession().setSessionTitle(next.sessionId, `#${slug}`);
    } catch (err) {
      console.warn('[hermesChannels] could not retitle the room session', err);
    }
  }
  return { success: true, channel: next };
}

/**
 * Delete a room (ADR 0010 §3). Only Boundary's record goes: every session the room linked
 * becomes an ordinary Hermes chat filed in the room's project, and Hermes keeps its
 * transcript. The room's Mentions go with it, since they are read from stored rooms.
 */
export function deleteHermesChannel(
  payload: HermesChannelDeletePayload
): HermesChannelDeleteResult {
  const channel = getStoredChannel(payload.channelId?.trim() ?? '');
  if (!channel) {
    return { success: false, error: 'Channel not found.' };
  }
  const projectId = channel.projectId ?? null;
  const sessionIds = [...new Set([channel.sessionId, ...listSessionsForChannel(channel.id)])];
  for (const id of sessionIds) {
    clearSessionChannelId(id);
    setSessionAgentSlug(id, BUILTIN_ASSISTANT_SLUG);
  }
  setSessionProjectIds(Object.fromEntries(sessionIds.map((id) => [id, projectId])));
  deleteStoredChannel(channel.id);
  const last = getLastOpened();
  if (last?.kind === 'channel' && last.id === channel.id) {
    setLastOpened(null);
  }
  return { success: true, sessionIds, projectId };
}

/**
 * Make channel: a Hermes chat becomes a room's transcript. Only Hermes chats qualify (DMs are
 * one ongoing thread, side chats belong to a personality's profile). The built-in agent
 * starts as a member so the room has someone to @ (ADR 0023 §9).
 */
export function makeChannelFromHermesChat(
  payload: HermesMakeChannelFromChatPayload
): HermesMakeChannelFromChatResult {
  const sessionId = payload.sessionId?.trim();
  const title = payload.title.trim().replace(/^#/, '');
  if (!sessionId) {
    return { success: false, error: 'Missing session id.' };
  }
  if (!title) {
    return { success: false, error: 'Channel name is required.' };
  }
  if (getSessionChannelId(sessionId) || getChannelBySessionId(sessionId)) {
    return { success: false, error: 'Session is already a channel.' };
  }
  const owner = getSessionAgentSlug(sessionId) ?? BUILTIN_ASSISTANT_SLUG;
  if (owner !== BUILTIN_ASSISTANT_SLUG) {
    return { success: false, error: 'Only Hermes chats can become channels.' };
  }

  const baseSlug = agentSlugFromDisplayName(payload.slug?.trim() || title);
  const slug = uniqueChannelSlug(baseSlug);
  const memberSlugs = normalizeMemberSlugs([
    BUILTIN_ASSISTANT_SLUG,
    ...(payload.memberSlugs ?? []),
  ]);
  const now = new Date().toISOString();
  const channelId = randomUUID();
  const channel: ChannelRecord = {
    id: channelId,
    slug,
    title,
    sessionId,
    memberSlugs,
    // The room keeps the chat's project (ADR 0024).
    projectId: getSessionProjectId(sessionId) ?? null,
    createdAt: now,
    updatedAt: now,
  };
  upsertStoredChannel(channel);
  setSessionChannelId(sessionId, channelId);
  setSessionAgentSlug(sessionId, BUILTIN_ASSISTANT_SLUG);
  clearStandingPinsForSession(sessionId);
  setLastOpened({ kind: 'channel', id: channelId });

  return {
    success: true,
    channel,
    thread: {
      id: sessionId,
      title: `#${slug}`,
      updatedAt: now,
      source: 'boundary',
      kind: 'channel',
      channelId,
      channelSlug: slug,
      agentSlug: BUILTIN_ASSISTANT_SLUG,
    },
  };
}

/** The room a session id belongs to, by its record or by any id linked to it. */
export function channelForSession(sessionId: string | null | undefined): ChannelRecord | null {
  if (!sessionId) return null;
  const linked = getSessionChannelId(sessionId);
  return getChannelBySessionId(sessionId) ?? (linked ? getStoredChannel(linked) : null);
}

/**
 * Point a room at `targetId` (a stored Hermes session) and bring along everything Boundary
 * kept under its older ids: posts and who spoke. Older ids stay linked, so a renderer still
 * holding one finds the room.
 */
export function moveChannelSession(channel: ChannelRecord, targetId: string): ChannelRecord {
  const firstPostAt = (id: string) => {
    const at = listChannelPosts(id)[0]?.createdAt;
    return at ? Date.parse(at) : Number.POSITIVE_INFINITY;
  };
  const older = [...new Set([...listSessionsForChannel(channel.id), channel.sessionId])]
    .filter((id) => id && id !== targetId)
    .sort((a, b) => firstPostAt(a) - firstPostAt(b));
  for (const id of older) {
    migrateChannelPosts(id, targetId);
    migrateSessionSpeakers(id, targetId);
  }
  setSessionChannelId(targetId, channel.id);
  setSessionAgentSlug(targetId, BUILTIN_ASSISTANT_SLUG);
  if (channel.sessionId === targetId) return channel;
  const next: ChannelRecord = { ...channel, sessionId: targetId };
  upsertStoredChannel(next);
  return next;
}

/**
 * Repair rooms whose session id Hermes no longer knows. Before this fix a room kept the
 * gateway's runtime id, which dies when Hermes restarts. Each such room moves to its stored
 * session: the gateway's own mapping when it still has one, else the newest unclaimed stored
 * session titled `#slug`. Runs on each chat-list load with Hermes's stored session list.
 */
export function reconcileChannelSessions(
  storedSessions: readonly HermesChatThreadSummary[],
  storedIdOf: (id: string) => string
): number {
  const listed = new Set(storedSessions.map((s) => s.id));
  const channels = listStoredChannels();
  const claimed = new Set(channels.map((c) => c.sessionId).filter((id) => listed.has(id)));
  let moved = 0;
  for (const channel of channels) {
    if (listed.has(channel.sessionId)) continue;
    let target: string | undefined = storedIdOf(channel.sessionId);
    if (!target || !listed.has(target) || claimed.has(target)) {
      target = storedSessions
        .filter((s) => s.title === `#${channel.slug}` && !claimed.has(s.id))
        .sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0))[0]?.id;
    }
    if (!target) continue;
    moveChannelSession(channel, target);
    claimed.add(target);
    moved += 1;
  }
  return moved;
}

function clearStandingPinsForSession(sessionId: string): void {
  const map = getStandingDmMap();
  for (const [slug, id] of Object.entries(map)) {
    if (id === sessionId) setStandingDmSessionId(slug, null);
  }
}

/**
 * Interleave durable channel posts with gateway assistant turns.
 * Gateway user lines are dropped when a local overlay exists — they are the
 * concatenated wake prompt, not the room's individual posts.
 */
export function mergeChannelTranscript(
  posts: ChannelPostRecord[],
  gatewayMessages: HermesChatMessage[]
): HermesChatMessage[] {
  if (posts.length === 0) return gatewayMessages;

  const assistants = gatewayMessages.filter((m) => m.role === 'assistant');
  const extras = gatewayMessages.filter(
    (m) => m.role !== 'assistant' && m.role !== 'user'
  );
  const out: HermesChatMessage[] = [...extras];
  let assistantIndex = 0;

  for (const post of posts) {
    const timestamp = toUnixSeconds(post.createdAt);
    out.push({
      role: 'user',
      content: post.content,
      delivery: post.delivery,
      ...(timestamp != null ? { timestamp } : {}),
    });
    if (post.delivery !== 'woke') continue;
    const n = post.assistantCount;
    if (n == null) continue;
    for (let i = 0; i < n && assistantIndex < assistants.length; i += 1) {
      out.push(assistants[assistantIndex]);
      assistantIndex += 1;
    }
  }

  while (assistantIndex < assistants.length) {
    out.push(assistants[assistantIndex]);
    assistantIndex += 1;
  }
  return out;
}

/** Most backlog tokens one wake prompt carries ahead of the @ message. */
export const WAKE_BACKLOG_TOKEN_BUDGET = 8_000;

/** Rough token count (about 4 characters per token); close enough for a budget. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build the prompt that wakes a room's agents: the unread posts since the last wake, then
 * the @ message. The @ message always goes in whole. Posts fill the budget newest first and
 * are never cut mid-post; older ones that don't fit are left out with a note saying how many.
 */
export function buildChannelWakePrompt(
  unreadPosts: readonly Pick<ChannelPostRecord, 'content'>[],
  userText: string,
  budgetTokens: number = WAKE_BACKLOG_TOKEN_BUDGET
): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = unreadPosts.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(unreadPosts[i].content);
    if (used + cost > budgetTokens) break;
    kept.unshift(unreadPosts[i].content);
    used += cost;
  }
  const omitted = unreadPosts.length - kept.length;
  const parts = [
    ...(omitted > 0
      ? [`[${omitted} earlier room post${omitted === 1 ? '' : 's'} omitted to fit the context budget]`]
      : []),
    ...kept,
    userText,
  ];
  return parts.join('\n\n');
}
