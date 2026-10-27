import type {
  AgentProfile,
  ChannelPostRecord,
  ChannelRecord,
  HermesChatMessage,
  HermesMentionRecord,
  HermesMentionsListResult,
} from '../../../../shared/types/hermesChat';
import { parseMemberMentions } from '../../../../shared/hermesMentions';
import { getHermesGatewaySession } from './hermesGatewaySession';
import {
  getMentionsSeenAt,
  getSessionSpeakers,
  listChannelPosts,
  listStoredAgents,
  listStoredChannels,
  setMentionsSeenAt,
} from './hermesAgentStore';

type RoomMention = Omit<HermesMentionRecord, 'unseen'>;

/**
 * Your @s in one room, paired with the replies (ADR 0023 §6). Walks the room's posts in
 * order as `mergeChannelTranscript` does: a woken post owns the next `assistantCount`
 * replies, and the room's speaker records say who gave each one. A mention counts when the
 * agent answered it, or when the agent is still a member (so it could yet answer). Replies
 * from agents woken by another agent are never yours.
 */
export function buildRoomMentions(input: {
  channel: ChannelRecord;
  posts: readonly ChannelPostRecord[];
  /** The room's assistant turns from Hermes, in order. */
  assistants: readonly HermesChatMessage[];
  /** Who spoke each assistant turn, by ordinal. */
  speakers: ReadonlyArray<{ ordinal: number; agentSlug: string }>;
  agents: readonly AgentProfile[];
}): RoomMention[] {
  const { channel, posts, assistants, speakers, agents } = input;
  const speakerAt = new Map(speakers.map((s) => [s.ordinal, s.agentSlug] as const));
  const out: RoomMention[] = [];
  let assistantIndex = 0;

  for (const post of posts) {
    if (post.delivery !== 'woke') continue;
    const count = post.assistantCount ?? 0;
    const replies: Array<{ slug: string | undefined; message: HermesChatMessage }> = [];
    for (let i = 0; i < count && assistantIndex < assistants.length; i += 1) {
      replies.push({ slug: speakerAt.get(assistantIndex), message: assistants[assistantIndex] });
      assistantIndex += 1;
    }
    for (const agentSlug of parseMemberMentions(post.content, [...agents])) {
      const reply = replies.find((r) => r.slug === agentSlug);
      if (!reply && !channel.memberSlugs.includes(agentSlug)) continue;
      const replyAt =
        reply?.message.timestamp != null
          ? new Date(reply.message.timestamp * 1000).toISOString()
          : post.createdAt;
      out.push({
        id: `${post.id}:${agentSlug}`,
        channelId: channel.id,
        channelSlug: channel.slug,
        sessionId: channel.sessionId,
        agentSlug,
        text: post.content,
        at: post.createdAt,
        status: reply ? 'replied' : 'waiting',
        ...(reply
          ? { reply: { text: reply.message.content, at: replyAt } }
          : {}),
      });
    }
  }
  return out;
}

/**
 * A room's assistant turns. `session.history` only takes a live runtime id, so it is
 * tried only when this connection already holds one; otherwise the stored id is resumed.
 */
async function readRoomAssistants(sessionId: string): Promise<HermesChatMessage[]> {
  const gateway = getHermesGatewaySession();
  let messages: HermesChatMessage[] = [];
  const runtimeId = gateway.runtimeSessionId(sessionId);
  if (runtimeId) {
    try {
      messages = await gateway.getSessionHistory(runtimeId);
    } catch {
      /* reaped since; resume below */
    }
  }
  if (messages.length === 0) {
    try {
      messages = (await gateway.resumeSession(sessionId)).messages;
    } catch {
      messages = [];
    }
  }
  return messages.filter((m) => m.role === 'assistant');
}

/** Per room, keyed by what changes when the room does. Cleared by tests. */
const cache = new Map<string, { key: string; mentions: RoomMention[] }>();

export function clearMentionCacheForTests(): void {
  cache.clear();
}

async function roomMentions(channel: ChannelRecord, agents: AgentProfile[]): Promise<RoomMention[]> {
  const posts = listChannelPosts(channel.sessionId);
  if (!posts.some((p) => p.delivery === 'woke')) return [];
  const speakers = getSessionSpeakers(channel.sessionId);
  const key = [
    channel.sessionId,
    channel.updatedAt,
    posts.length,
    posts.reduce((n, p) => n + (p.assistantCount ?? 0), 0),
    speakers.length,
    channel.memberSlugs.join(','),
  ].join('|');
  const hit = cache.get(channel.id);
  if (hit && hit.key === key) return hit.mentions;
  const assistants = await readRoomAssistants(channel.sessionId);
  const mentions = buildRoomMentions({ channel, posts, assistants, speakers, agents });
  cache.set(channel.id, { key, mentions });
  return mentions;
}

/** The watermark, set to now on first read so existing history is not all "new". */
function seenWatermark(): string {
  const seen = getMentionsSeenAt();
  if (seen) return seen;
  const now = new Date().toISOString();
  setMentionsSeenAt(now);
  return now;
}

const isUnseen = (m: RoomMention, seenAt: string) =>
  m.status === 'replied' && Boolean(m.reply) && Date.parse(m.reply!.at) > Date.parse(seenAt);

export async function listHermesMentions(): Promise<HermesMentionsListResult> {
  try {
    const agents = listStoredAgents();
    const channels = listStoredChannels();
    const seenAt = seenWatermark();
    const all = (await Promise.all(channels.map((c) => roomMentions(c, agents)))).flat();
    const mentions = all
      .map((m) => ({ ...m, unseen: isUnseen(m, seenAt) }))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { success: true, mentions };
  } catch (err) {
    return { success: false, mentions: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function markHermesMentionsSeen(): { success: boolean } {
  setMentionsSeenAt(new Date().toISOString());
  return { success: true };
}
