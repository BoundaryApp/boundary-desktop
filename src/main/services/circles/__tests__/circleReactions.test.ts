import { describe, expect, it } from 'vitest';
import { isReactionEmoji, MAX_REACTIONS_PER_MESSAGE, QUICK_REACTIONS } from '../../../../shared/circleReactions';
import {
  changedReactionRefs,
  indexReactions,
  parseReactionRecord,
  reactionRecordKey,
  reactionsFor,
  unreadReactionCandidates,
  type ReactionRecordValue,
} from '../circleReactions';
import type { CircleRecordEntry } from '../networkMessages';

const ME = 'a'.repeat(64);
const MAYA = 'b'.repeat(64);
const SAM = 'c'.repeat(64);
const AUTHOR = 'd'.repeat(64);
const ID = '0123456789abcdef0123456789abcdef';
const OTHER_ID = 'fedcba9876543210fedcba9876543210';

const value = (over: Partial<ReactionRecordValue> = {}): ReactionRecordValue => ({
  channel: 'general',
  author: AUTHOR,
  id: ID,
  name: 'Maya',
  emoji: [{ e: '👍', at: 10 }],
  ...over,
});

const record = (
  identity: string,
  v: unknown,
  key?: string,
  over: Partial<CircleRecordEntry> = {},
): CircleRecordEntry => {
  const val = v as ReactionRecordValue;
  return {
    app: 'reactions',
    scope: 'member',
    identity,
    key: key ?? reactionRecordKey(val.channel, val.author, val.id),
    value: v,
    keep: true,
    circleKey: 'circle-1',
    confirmed: true,
    ...over,
  };
};

describe('parseReactionRecord', () => {
  it('accepts a well-formed record', () => {
    const v = value();
    expect(parseReactionRecord(record(MAYA, v))).toEqual(v);
  });

  it("ignores a record whose key isn't its message's", () => {
    const keyForA = reactionRecordKey('general', AUTHOR, ID);
    expect(parseReactionRecord(record(MAYA, value({ id: OTHER_ID }), keyForA))).toBeNull();
  });

  it('ignores the whole record for one bad emoji, 21 entries, a repeated emoji, a zero at, or a circle-scope record', () => {
    expect(parseReactionRecord(record(MAYA, value({ emoji: [{ e: '👍', at: 1 }, { e: 'a', at: 2 }] })))).toBeNull();
    const many = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋'];
    expect(many).toHaveLength(MAX_REACTIONS_PER_MESSAGE + 1);
    expect(parseReactionRecord(record(MAYA, value({ emoji: many.map((e) => ({ e, at: 1 })) })))).toBeNull();
    expect(parseReactionRecord(record(MAYA, value({ emoji: [{ e: '👍', at: 1 }, { e: '👍', at: 2 }] })))).toBeNull();
    expect(parseReactionRecord(record(MAYA, value({ emoji: [{ e: '👍', at: 0 }] })))).toBeNull();
    expect(parseReactionRecord(record(null as unknown as string, value(), undefined, { scope: 'circle', identity: null }))).toBeNull();
  });

  it('ignores records with a bad author, id, name or empty emoji list', () => {
    expect(parseReactionRecord(record(MAYA, value({ author: 'xyz' })))).toBeNull();
    expect(parseReactionRecord(record(MAYA, value({ id: 'short' })))).toBeNull();
    expect(parseReactionRecord(record(MAYA, value({ name: '' })))).toBeNull();
    expect(parseReactionRecord(record(MAYA, value({ name: 'x'.repeat(81) })))).toBeNull();
    expect(parseReactionRecord(record(MAYA, value({ emoji: [] })))).toBeNull();
  });
});

describe('isReactionEmoji', () => {
  it('accepts ZWJ, flag and skin-tone emoji and refuses text or two emoji', () => {
    for (const e of ['👨‍👩‍👧', '🇺🇸', '👍🏽', '❤️']) expect(isReactionEmoji(e)).toBe(true);
    for (const e of ['a', '👍👍', '❤', '', 5]) expect(isReactionEmoji(e)).toBe(false);
  });
});

describe('reactionsFor', () => {
  it('folds pills in first-use order, with You first and Left for departed members', () => {
    const index = indexReactions([
      record(MAYA, value({ name: 'Maya', emoji: [{ e: '👍', at: 20 }, { e: '😂', at: 40 }] })),
      record(SAM, value({ name: 'Sam', emoji: [{ e: '👍', at: 30 }] })),
      record(ME, value({ name: 'Me', emoji: [{ e: '👍', at: 50 }] })),
      record(ME, value({ id: OTHER_ID, name: 'Me', emoji: [{ e: '🙏', at: 5 }] })),
    ]);
    const out = reactionsFor(index, 'general', { author: AUTHOR, id: ID }, ME, new Set([ME, MAYA]));
    expect(out).toEqual([
      {
        emoji: '👍',
        count: 3,
        mine: true,
        people: [
          { identity: ME, name: 'Me', left: false, at: 50 },
          { identity: MAYA, name: 'Maya', left: false, at: 20 },
          { identity: SAM, name: 'Sam', left: true, at: 30 },
        ],
      },
      { emoji: '😂', count: 1, mine: false, people: [{ identity: MAYA, name: 'Maya', left: false, at: 40 }] },
    ]);
  });

  it('returns nothing for a message nobody reacted to', () => {
    expect(reactionsFor(indexReactions([]), 'general', { author: AUTHOR, id: ID }, ME, new Set())).toEqual([]);
  });
});

describe('changedReactionRefs', () => {
  it("reports which messages' reactions changed", () => {
    const untouched = record(MAYA, value({ id: OTHER_ID }));
    const toggled = record(MAYA, value());
    const third = 'ab'.repeat(8);
    const deleted = record(SAM, value({ id: third }));
    const before = indexReactions([untouched, toggled, deleted]);
    const after = indexReactions([untouched, record(MAYA, value({ emoji: [{ e: '👍', at: 10 }, { e: '😂', at: 11 }] }))]);
    const refs = changedReactionRefs(before, after);
    expect(refs).toHaveLength(2);
    expect(refs).toEqual(
      expect.arrayContaining([
        { channel: 'general', author: AUTHOR, id: ID },
        { channel: 'general', author: AUTHOR, id: third },
      ]),
    );
  });
});

describe('unreadReactionCandidates', () => {
  it("counts only others' reactions on my messages after sinceAt", () => {
    const mine = { author: ME, id: ID };
    const index = indexReactions([
      record(MAYA, value({ ...mine, emoji: [{ e: '👍', at: 100 }, { e: '😂', at: 200 }, { e: '🙏', at: 50 }] })),
      record(SAM, value({ ...mine, emoji: [{ e: '👍', at: 150 }] })),
      record(ME, value({ ...mine, emoji: [{ e: '👍', at: 300 }] })),
      record(MAYA, value({ id: OTHER_ID, emoji: [{ e: '👍', at: 400 }] })),
    ]);
    expect(unreadReactionCandidates(index, 'general', ME, 75, 1000)).toEqual([{ ref: mine, count: 3 }]);
    expect(unreadReactionCandidates(index, 'other', ME, 0, 1000)).toEqual([]);
  });
});

describe('QUICK_REACTIONS', () => {
  it('holds only emoji that pass isReactionEmoji', () => {
    expect(QUICK_REACTIONS.length).toBeGreaterThan(0);
    for (const emoji of QUICK_REACTIONS) expect(isReactionEmoji(emoji)).toBe(true);
  });
});
