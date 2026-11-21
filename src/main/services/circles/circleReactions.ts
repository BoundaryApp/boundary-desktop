import { createHash } from 'node:crypto';
import { isReactionEmoji, MAX_REACTIONS_PER_MESSAGE, REACTIONS_APP } from '../../../shared/circleReactions';
import type { CircleMessageRef, CircleReaction } from '../../../shared/types/circles';
import { isRecordName } from './circleOps';
import type { CircleRecordEntry } from './networkMessages';
import { HEX_KEY_PATTERN } from '../../../shared/hexKeys';
import { MESSAGE_ID_PATTERN } from '../../../shared/circleReplies';

const MAX_NAME = 80;

export interface ReactionRecordValue {
  channel: string;
  author: string;
  id: string;
  name: string;
  emoji: { e: string; at: number }[];
}

/** A message's reactions from every member who reacted, keyed `${channel}/${author}/${id}`. */
export interface ReactionIndex {
  byMessage: Map<string, { identity: string; value: ReactionRecordValue }[]>;
}

/** `m.` plus the first 40 hex of sha256 over the message's channel, author and id. */
export const reactionRecordKey = (channel: string, author: string, id: string): string =>
  `m.${createHash('sha256').update(`${channel}/${author}/${id}`).digest('hex').slice(0, 40)}`;

const messageKey = (channel: string, author: string, id: string): string => `${channel}/${author}/${id}`;

/** The record's value when every check passes; any failure ignores the whole record. */
export const parseReactionRecord = (record: CircleRecordEntry): ReactionRecordValue | null => {
  if (record.app !== REACTIONS_APP || record.scope !== 'member' || !record.identity) return null;
  const v = record.value;
  if (!v || typeof v !== 'object') return null;
  const { channel, author, id, name, emoji } = v as Record<string, unknown>;
  if (typeof author !== 'string' || !HEX_KEY_PATTERN.test(author)) return null;
  if (typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id)) return null;
  if (!isRecordName(channel)) return null;
  if (record.key !== reactionRecordKey(channel, author, id)) return null;
  if (typeof name !== 'string' || !name || name.length > MAX_NAME) return null;
  if (!Array.isArray(emoji) || emoji.length < 1 || emoji.length > MAX_REACTIONS_PER_MESSAGE) return null;
  const seen = new Set<string>();
  const entries: { e: string; at: number }[] = [];
  for (const item of emoji) {
    if (!item || typeof item !== 'object') return null;
    const { e, at } = item as Record<string, unknown>;
    if (!isReactionEmoji(e) || seen.has(e)) return null;
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return null;
    seen.add(e);
    entries.push({ e, at });
  }
  return { channel, author, id, name, emoji: entries };
};

export const indexReactions = (records: Iterable<CircleRecordEntry>): ReactionIndex => {
  const byMessage: ReactionIndex['byMessage'] = new Map();
  for (const record of records) {
    const value = parseReactionRecord(record);
    if (!value || !record.identity) continue;
    const key = messageKey(value.channel, value.author, value.id);
    const list = byMessage.get(key);
    if (list) list.push({ identity: record.identity, value });
    else byMessage.set(key, [{ identity: record.identity, value }]);
  }
  return { byMessage };
};

/** Pills in order of each emoji's earliest use; within a pill the user first, then by time. */
export const reactionsFor = (
  index: ReactionIndex,
  channel: string,
  ref: CircleMessageRef,
  me: string,
  members: ReadonlySet<string>,
): CircleReaction[] => {
  const reactors = index.byMessage.get(messageKey(channel, ref.author, ref.id));
  if (!reactors) return [];
  const pills = new Map<string, { first: number; people: CircleReaction['people'] }>();
  for (const { identity, value } of reactors) {
    for (const { e, at } of value.emoji) {
      let pill = pills.get(e);
      if (!pill) pills.set(e, (pill = { first: at, people: [] }));
      pill.first = Math.min(pill.first, at);
      pill.people.push({ identity, name: value.name, left: !members.has(identity), at });
    }
  }
  return [...pills]
    .sort((a, b) => a[1].first - b[1].first)
    .map(([emoji, { people }]) => {
      people.sort((a, b) => Number(b.identity === me) - Number(a.identity === me) || a.at - b.at);
      return { emoji, count: people.length, mine: people.some((p) => p.identity === me), people };
    });
};

const signature = (list: ReactionIndex['byMessage'] extends Map<string, infer T> ? T : never): string =>
  list
    .map(({ identity, value }) => `${identity}:${value.name}:${value.emoji.map((x) => `${x.e}@${x.at}`).join(',')}`)
    .sort()
    .join('|');

/** Messages whose reactions differ between two indexes, including ones that lost every reaction. */
export const changedReactionRefs = (
  before: ReactionIndex,
  after: ReactionIndex,
): { channel: string; author: string; id: string }[] => {
  const out: { channel: string; author: string; id: string }[] = [];
  const keys = new Set([...before.byMessage.keys(), ...after.byMessage.keys()]);
  for (const key of keys) {
    const a = before.byMessage.get(key);
    const b = after.byMessage.get(key);
    if ((a ? signature(a) : '') === (b ? signature(b) : '')) continue;
    const [channel, author, id] = key.split('/');
    out.push({ channel, author, id });
  }
  return out;
};

/** How far ahead of this device's clock a reactor's `at` may be and still count as unread (2 minutes). */
const REACTION_CLOCK_SKEW_MS = 120_000;

/**
 * Others' reactions on `me`'s messages in a channel, counted per message, with `sinceAt < at <=
 * now + REACTION_CLOCK_SKEW_MS`. A later `at` is a reactor clock far ahead of this device's, which
 * would keep the channel unread until the clock caught up.
 */
export const unreadReactionCandidates = (
  index: ReactionIndex,
  channel: string,
  me: string,
  sinceAt: number,
  now: number,
): { ref: CircleMessageRef; count: number }[] => {
  const out: { ref: CircleMessageRef; count: number }[] = [];
  for (const reactors of index.byMessage.values()) {
    const first = reactors[0]?.value;
    if (!first || first.channel !== channel || first.author !== me) continue;
    let count = 0;
    for (const { identity, value } of reactors) {
      if (identity === me) continue;
      count += value.emoji.filter((x) => x.at > sinceAt && x.at <= now + REACTION_CLOCK_SKEW_MS).length;
    }
    if (count > 0) out.push({ ref: { author: first.author, id: first.id }, count });
  }
  return out;
};
