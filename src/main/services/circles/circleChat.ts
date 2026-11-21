/**
 * Reading a Circle's chat from its view (ADR 0042 §4–§6). `apply` stores each channel's messages
 * by position, and positions change while entries are unconfirmed, so everything here names a
 * message by `author/id` and uses positions only to read in order.
 */
import type Hyperbee from 'hyperbee';
import type { HyperbeeEntry } from 'hyperbee';
import { MENTIONS_FORMAT, mentionsMe } from '../../../shared/circleMentions';
import type { CircleChatUpdate, CircleMentions, CircleMessage, CircleMessageRef, CircleReadPosition } from '../../../shared/types/circles';
import { refKey } from '../../../shared/circleMessageRef';
import { repliesToMe } from '../../../shared/circleReplies';
import { chatCountKey, chatIndexKey, chatMessageKey, type CircleMessageRecord } from './circleOps';
import type { CircleRecordEntry } from './networkMessages';
import { reactionsFor, unreadReactionCandidates, type ReactionIndex } from './circleReactions';

/** Every Circle has this channel with no record (Circle chats spec, the public seam). */
const DEFAULT_CHANNEL = 'general';
/** Channels are Circle records of this app (ADR 0042 §1). */
const CHAT_APP = 'chat';
const DEFAULT_CHANNEL_NAME = 'General';
const MAX_CHANNEL_NAME = 80;
/** How far back an unread count looks when the read message is gone. */
const MAX_UNREAD_SCAN = 1_000;
/** Every chat key; a scan diffs this range. */
const CHAT_RANGE = { gte: 'chat/', lt: 'chat/\xff' };

/** Who is reading and how much of the view is confirmed. */
export interface ChatReader {
  circleKey: string;
  /** This user's identity. */
  me: string;
  /** View blocks below this are confirmed. */
  signedLength: number;
  /** Every member's reactions, from the last record scan. */
  reactions: ReactionIndex;
  /** Identities of the current members; a reactor outside it shows as having left. */
  members: ReadonlySet<string>;
}

const isMessageKey = (key: string): boolean => key.includes('/messages/');

function messagesRange(channel: string): { gte: string; lt: string } {
  const prefix = chatMessageKey(channel, 0).slice(0, -12);
  return { gte: prefix, lt: `${prefix}\xff` };
}

/**
 * Channel names by id: `general`, then each `chat` record at Circle scope. A record's value is
 * untrusted, so a channel whose name won't do shows its id.
 */
export function chatChannels(records: Iterable<CircleRecordEntry>): Map<string, string> {
  const channels = new Map([[DEFAULT_CHANNEL, DEFAULT_CHANNEL_NAME]]);
  for (const record of records) {
    if (record.app !== CHAT_APP || record.scope !== 'circle') continue;
    const name = (record.value as { name?: unknown } | null)?.name;
    const fits = typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_CHANNEL_NAME;
    if (fits) channels.set(record.key, name.trim());
    else if (record.key !== DEFAULT_CHANNEL) channels.set(record.key, record.key);
  }
  return channels;
}

/** A record's stored mentions in the shape messages carry: both fields present, null when none. */
function mentionsOf(record: CircleMessageRecord): CircleMentions | null {
  return record.mentions ? { members: record.mentions.members ?? [], channel: record.mentions.channel === true } : null;
}

export function toMessage(entry: HyperbeeEntry, reader: ChatReader): CircleMessage {
  const record = entry.value as CircleMessageRecord;
  return {
    circleKey: reader.circleKey,
    channel: record.channel,
    author: record.author,
    id: record.id,
    name: record.name,
    agent: record.agent ?? null,
    text: record.text,
    at: record.at,
    confirmed: entry.seq < reader.signedLength,
    edited: record.edited,
    deleted: record.deleted,
    shared: record.shared ?? null,
    call: record.call ?? null,
    mentions: mentionsOf(record),
    reply: record.reply ?? null,
    reactions: reactionsFor(reader.reactions, record.channel, { author: record.author, id: record.id }, reader.me, reader.members),
    mine: record.author === reader.me,
  };
}

/** One message by `author/id`, or null when this view doesn't hold it. */
export async function findChatMessage(
  bee: Hyperbee,
  channel: string,
  ref: CircleMessageRef,
  reader: ChatReader
): Promise<CircleMessage | null> {
  const position = (await bee.get(chatIndexKey(channel, ref.author, ref.id)))?.value;
  if (typeof position !== 'number') return null;
  const key = chatMessageKey(channel, position);
  for await (const entry of bee.createReadStream({ gte: key, lte: key })) return toMessage(entry, reader);
  return null;
}

/** The newest `limit` messages of a channel, or those before `before`, oldest first. */
export async function readChatMessages(
  bee: Hyperbee,
  channel: string,
  { before, limit }: { before?: CircleMessageRef; limit: number },
  reader: ChatReader
): Promise<{ messages: CircleMessage[]; more: boolean }> {
  const range = messagesRange(channel);
  if (before) {
    const position = (await bee.get(chatIndexKey(channel, before.author, before.id)))?.value;
    if (typeof position !== 'number') throw new Error('That message isn’t in this channel.');
    range.lt = chatMessageKey(channel, position);
  }
  const messages: CircleMessage[] = [];
  for await (const entry of bee.createReadStream({ ...range, reverse: true, limit: limit + 1 })) {
    messages.push(toMessage(entry, reader));
  }
  const more = messages.length > limit;
  return { messages: messages.slice(0, limit).reverse(), more };
}

/**
 * Messages after a read position. When the read message disappeared as its order settled, the
 * count falls back to messages after its time, which can be off by a few.
 */
async function unreadCount(bee: Hyperbee, channel: string, read: CircleReadPosition | undefined): Promise<number> {
  const count = (await bee.get(chatCountKey(channel)))?.value;
  const total = typeof count === 'number' ? count : 0;
  if (!read) return total;
  const position = (await bee.get(chatIndexKey(channel, read.author, read.id)))?.value;
  if (typeof position === 'number') return Math.max(0, total - position - 1);
  let unread = 0;
  for await (const { value } of bee.createReadStream({ ...messagesRange(channel), reverse: true, limit: MAX_UNREAD_SCAN })) {
    if ((value as CircleMessageRecord).at <= read.at) break;
    unread++;
  }
  return unread;
}

/**
 * Whether an unread message from someone else mentions `me`. Reads "unread" as `unreadCount`
 * does: after the read message's position, or after its time when it is gone, and looks at no
 * more than `MAX_UNREAD_SCAN` records.
 */
export async function unreadMentioned(
  bee: Hyperbee,
  channel: string,
  read: CircleReadPosition | undefined,
  me: string,
  channelMentions: boolean
): Promise<boolean> {
  const readPosition = read ? (await bee.get(chatIndexKey(channel, read.author, read.id)))?.value : undefined;
  for await (const { value } of bee.createReadStream({ ...messagesRange(channel), reverse: true, limit: MAX_UNREAD_SCAN })) {
    const record = value as CircleMessageRecord;
    if (read) {
      if (typeof readPosition === 'number' ? record.position <= readPosition : record.at <= read.at) break;
    }
    if (record.deleted || record.author === me) continue;
    if (mentionsMe(mentionsOf(record), me, channelMentions) || repliesToMe({ reply: record.reply ?? null, author: record.author }, me)) return true;
  }
  return false;
}

/**
 * Others' reactions, newer than the read position's `reactionsAt`, to `me`'s messages that this
 * view still holds and that aren't deleted. A position without `reactionsAt` counts none.
 */
async function unreadReactions(
  bee: Hyperbee,
  channel: string,
  read: CircleReadPosition | undefined,
  me: string,
  reactions: ReactionIndex,
  now: number
): Promise<number> {
  if (read?.reactionsAt === undefined) return 0;
  // Only the record's deleted flag is read, so the reader's other fields are placeholders.
  const reader: ChatReader = { circleKey: '', me, signedLength: 0, reactions, members: new Set() };
  let total = 0;
  for (const { ref, count } of unreadReactionCandidates(reactions, channel, me, read.reactionsAt, now)) {
    const message = await findChatMessage(bee, channel, ref, reader);
    if (message && !message.deleted) total += count;
  }
  return total;
}

/**
 * A channel's unread count (messages plus others' reactions to `me`'s messages), and whether an
 * unread message mentions `me`. The mention scan runs only when a message is unread and the
 * Circle is at `MENTIONS_FORMAT` or later, since no record below it holds mentions. Reactions
 * never set `mentioned`.
 */
export async function channelUnread(
  bee: Hyperbee,
  channel: string,
  read: CircleReadPosition | undefined,
  {
    format,
    me,
    channelMentions,
    reactions,
    now,
  }: { format: number; me: string; channelMentions: boolean; reactions: ReactionIndex; now: number }
): Promise<{ unread: number; mentioned: boolean }> {
  const messages = await unreadCount(bee, channel, read);
  const unread = messages + (await unreadReactions(bee, channel, read, me, reactions, now));
  if (messages === 0 || format < MENTIONS_FORMAT) return { unread, mentioned: false };
  return { unread, mentioned: await unreadMentioned(bee, channel, read, me, channelMentions) };
}

const sameMessage = (a: CircleMessage, b: CircleMessage): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Follows one Circle's chat across view updates. Each scan diffs the view against its confirmed
 * length at the last scan, so it reads the unconfirmed tail and whatever changed since, never the
 * whole history. Confirmed blocks are never truncated, so that version stays readable.
 */
export class ChatScan {
  /** The view's confirmed length at the last scan; null before the first. */
  private signed: number | null = null;
  /** Messages the last scan saw unconfirmed, by `author/id`. */
  private unconfirmed = new Map<string, CircleMessage>();
  /** Every message reported or present at the first scan since the Circle opened, by `author/id`. */
  private readonly seen = new Set<string>();

  /**
   * What changed since the last scan, one update per channel that changed. The first scan only
   * sets the baseline: messages already in the view when a Circle opens aren't new. A message
   * that was reported gone and comes back after another reorder is reported as changed.
   */
  async scan(
    bee: Hyperbee,
    channels: ReadonlySet<string>,
    reader: ChatReader,
    reactionRefs: { channel: string; author: string; id: string }[] = []
  ): Promise<CircleChatUpdate[]> {
    const first = this.signed === null;
    const from = Math.min(this.signed ?? reader.signedLength, reader.signedLength);
    const updates = new Map<string, CircleChatUpdate>();
    const update = (channel: string): CircleChatUpdate => {
      let entry = updates.get(channel);
      if (!entry) {
        entry = { circleKey: reader.circleKey, channel, added: [], changed: [], gone: [] };
        updates.set(channel, entry);
      }
      return entry;
    };
    const present = new Set<string>();
    const unconfirmed = new Map<string, CircleMessage>();
    for await (const { left, right } of bee.createDiffStream(from, CHAT_RANGE)) {
      if (!left || !isMessageKey(left.key)) continue;
      const message = toMessage(left, reader);
      const ref = refKey(message);
      present.add(ref);
      if (!message.confirmed) unconfirmed.set(ref, message);
      if (first || !channels.has(message.channel)) {
        this.seen.add(ref);
        continue;
      }
      // The other side is at a confirmed version, so a message there was confirmed.
      const old =
        right && refKey(right.value as CircleMessageRecord) === ref ? { ...toMessage(right, reader), confirmed: true } : null;
      const before = this.unconfirmed.get(ref) ?? old;
      if (!before && !this.seen.has(ref)) {
        this.seen.add(ref);
        update(message.channel).added.push(message);
      } else if (!before || !sameMessage(before, message)) {
        update(message.channel).changed.push(message);
      }
    }
    // A reaction doesn't touch the message's block, so the diff doesn't see it. The first scan
    // only sets the baseline; a message already in this scan's update isn't reported twice.
    if (!first) {
      for (const { channel, author, id } of reactionRefs) {
        if (!channels.has(channel)) continue;
        const reported = updates.get(channel);
        const same = (m: CircleMessage) => m.author === author && m.id === id;
        if (reported?.added.some(same) || reported?.changed.some(same)) continue;
        const message = await findChatMessage(bee, channel, { author, id }, reader);
        if (message) update(channel).changed.push(message);
      }
    }
    for (const [ref, message] of this.unconfirmed) {
      if (present.has(ref) || !channels.has(message.channel)) continue;
      update(message.channel).gone.push({ author: message.author, id: message.id });
    }
    this.signed = reader.signedLength;
    this.unconfirmed = unconfirmed;
    return [...updates.values()];
  }
}
