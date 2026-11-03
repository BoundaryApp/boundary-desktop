/**
 * Reading a Circle's chat from its view (ADR 0042 §4–§6). `apply` stores each channel's messages
 * by position, and positions change while entries are unconfirmed, so everything here names a
 * message by `author/id` and uses positions only to read in order.
 */
import type Hyperbee from 'hyperbee';
import type { HyperbeeEntry } from 'hyperbee';
import type { CircleChatUpdate, CircleMessage, CircleMessageRef, CircleReadPosition } from '../../../shared/types/circles';
import { chatCountKey, chatIndexKey, chatMessageKey, type CircleMessageRecord } from './circleOps';
import type { CircleRecordEntry } from './networkMessages';

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
}

const refKey = (ref: CircleMessageRef): string => `${ref.author}/${ref.id}`;
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

function toMessage(entry: HyperbeeEntry, reader: ChatReader): CircleMessage {
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
export async function unreadCount(bee: Hyperbee, channel: string, read: CircleReadPosition | undefined): Promise<number> {
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
  async scan(bee: Hyperbee, channels: ReadonlySet<string>, reader: ChatReader): Promise<CircleChatUpdate[]> {
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
    for (const [ref, message] of this.unconfirmed) {
      if (present.has(ref) || !channels.has(message.channel)) continue;
      update(message.channel).gone.push({ author: message.author, id: message.id });
    }
    this.signed = reader.signedLength;
    this.unconfirmed = unconfirmed;
    return [...updates.values()];
  }
}
