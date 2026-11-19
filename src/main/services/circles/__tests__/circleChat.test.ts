import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { indexReactions, reactionRecordKey } from '../circleReactions';
import { channelUnread, chatChannels, toMessage, unreadMentioned } from '../circleChat';
import { chatCountKey, chatIndexKey, chatMessageKey, type CircleMessageRecord } from '../circleOps';
import type { CircleRecordEntry } from '../networkMessages';

const record = (key: string, value: unknown, extra: Partial<CircleRecordEntry> = {}): CircleRecordEntry => ({
  circleKey: 'k',
  app: 'chat',
  scope: 'circle',
  identity: null,
  key,
  value,
  confirmed: true,
  ...extra,
});

describe('chatChannels', () => {
  it('always has General, which a record can rename', () => {
    expect([...chatChannels([])]).toEqual([['general', 'General']]);
    expect(chatChannels([record('general', { name: ' Lobby ' })]).get('general')).toBe('Lobby');
  });

  it('adds a channel per Circle record of the chat app, showing its id when the name won’t do', () => {
    const channels = chatChannels([
      record('garden', { name: 'Garden' }),
      record('odd', { name: 42 }),
      record('long', { name: 'x'.repeat(81) }),
      record('general', null),
      record('mine', { name: 'Mine' }, { scope: 'member', identity: 'aa' }),
      record('other', { name: 'Other' }, { app: 'notes' }),
    ]);
    expect([...channels]).toEqual([
      ['general', 'General'],
      ['garden', 'Garden'],
      ['odd', 'odd'],
      ['long', 'long'],
    ]);
  });
});

const ME = 'aa'.repeat(32);
const BO = 'bb'.repeat(32);
const CY = 'cc'.repeat(32);

const message = (position: number, extra: Partial<CircleMessageRecord> = {}): CircleMessageRecord => ({
  channel: 'general',
  position,
  author: BO,
  id: position.toString(16).padStart(16, '0'),
  name: 'Bo',
  text: 'hi',
  at: 100 + position,
  edited: false,
  deleted: null,
  ...extra,
});

describe('toMessage', () => {
  const reader = { circleKey: 'k', me: ME, signedLength: 10, reactions: indexReactions([]), members: new Set<string>() };

  it('carries reactions from the reader’s index', () => {
    const target = message(0);
    const reacted = record(
      reactionRecordKey(target.channel, target.author, target.id),
      {
        channel: target.channel,
        author: target.author,
        id: target.id,
        name: 'Cy',
        emoji: [
          { e: '👍', at: 5 },
          { e: '🎉', at: 6 },
        ],
      },
      { app: 'reactions', scope: 'member', identity: CY }
    );
    const withIndex = { ...reader, reactions: indexReactions([reacted]), members: new Set([CY]) };
    const got = toMessage({ seq: 0, key: '', value: target } as never, withIndex).reactions;
    expect(got.map((r) => r.emoji)).toEqual(['👍', '🎉']);
    expect(got[0].people).toEqual([{ identity: CY, name: 'Cy', left: false, at: 5 }]);
    expect(toMessage({ seq: 0, key: '', value: message(1) } as never, withIndex).reactions).toEqual([]);
  });

  it('maps stored mentions to the message, with channel false when absent', () => {
    expect(toMessage({ seq: 0, key: '', value: message(0, { mentions: { members: [CY] } }) } as never, reader).mentions).toEqual({
      members: [CY],
      channel: false,
    });
    expect(toMessage({ seq: 0, key: '', value: message(0, { mentions: { channel: true } }) } as never, reader).mentions).toEqual({
      members: [],
      channel: true,
    });
  });

  it('gives null for a record without mentions', () => {
    expect(toMessage({ seq: 0, key: '', value: message(0) } as never, reader).mentions).toBeNull();
  });
});

describe('unreadMentioned', () => {
  let dir: string;
  let store: Corestore;
  let bee: Hyperbee;
  const put = async (record: CircleMessageRecord) => {
    await bee.put(chatMessageKey(record.channel, record.position), record);
    await bee.put(chatIndexKey(record.channel, record.author, record.id), record.position);
    await bee.put(chatCountKey(record.channel), record.position + 1);
  };
  const ref = (record: CircleMessageRecord) => ({ author: record.author, id: record.id, at: record.at });

  const first = message(0);
  const mentionsMe = message(1, { mentions: { members: [ME] } });
  const everyone = message(2, { mentions: { channel: true } });
  const last = message(3);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'unread-mentioned-'));
    store = new Corestore(dir);
    bee = new Hyperbee(store.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json' });
    await bee.ready();
    for (const record of [first, mentionsMe, everyone, last]) await put(record);
    await put(message(0, { channel: 'quiet' }));
    await put(message(1, { channel: 'quiet', author: ME, mentions: { members: [ME] } }));
    await put(message(0, { channel: 'gone', mentions: { members: [ME] }, deleted: 'author' }));
    await put(message(0, { channel: 'replied' }));
    await put(message(1, { channel: 'replied', reply: { author: ME, id: '00000000000000aa' } }));
    await put(message(0, { channel: 'others' }));
    await put(message(1, { channel: 'others', reply: { author: CY, id: '00000000000000aa' } }));
  });

  afterAll(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('is true when an unread message lists me', async () => {
    expect(await unreadMentioned(bee, 'general', undefined, ME, false)).toBe(true);
    expect(await unreadMentioned(bee, 'general', ref(first), ME, false)).toBe(true);
  });

  it('is false once the read position passes it', async () => {
    expect(await unreadMentioned(bee, 'general', ref(mentionsMe), ME, false)).toBe(false);
    expect(await unreadMentioned(bee, 'general', ref(last), ME, true)).toBe(false);
  });

  it('counts @channel only when the preference is on', async () => {
    expect(await unreadMentioned(bee, 'general', ref(mentionsMe), ME, false)).toBe(false);
    expect(await unreadMentioned(bee, 'general', ref(mentionsMe), ME, true)).toBe(true);
  });

  it('falls back to the read message’s time when it is gone', async () => {
    const vanished = { author: BO, id: 'ffffffffffffffff', at: mentionsMe.at };
    expect(await unreadMentioned(bee, 'general', vanished, ME, false)).toBe(false);
    expect(await unreadMentioned(bee, 'general', { ...vanished, at: first.at }, ME, false)).toBe(true);
  });

  describe('channelUnread', () => {
    const scanned = () => {
      const spy = vi.spyOn(bee, 'createReadStream');
      return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
    };

    it('reads no messages below format 3, even with an unread mention', async () => {
      const streams = scanned();
      expect(await channelUnread(bee, 'general', ref(first), { format: 2, me: ME, channelMentions: true, reactions: indexReactions([]), now: 1000 })).toEqual({
        unread: 3,
        mentioned: false,
      });
      expect(streams.count()).toBe(0);
      streams.restore();
    });

    it('reads no messages when nothing is unread', async () => {
      const streams = scanned();
      expect(await channelUnread(bee, 'general', ref(last), { format: 3, me: ME, channelMentions: true, reactions: indexReactions([]), now: 1000 })).toEqual({
        unread: 0,
        mentioned: false,
      });
      expect(streams.count()).toBe(0);
      streams.restore();
    });

    const beforeReply = { author: BO, id: '0000000000000000', at: 100 };

    it('marks an unread reply to me at format 3', async () => {
      expect(await channelUnread(bee, 'replied', beforeReply, { format: 3, me: ME, channelMentions: false, reactions: indexReactions([]), now: 1000 })).toEqual({
        unread: 1,
        mentioned: true,
      });
    });

    it('does not mark an unread reply to me at format 2', async () => {
      expect(await channelUnread(bee, 'replied', beforeReply, { format: 2, me: ME, channelMentions: false, reactions: indexReactions([]), now: 1000 })).toEqual({
        unread: 1,
        mentioned: false,
      });
    });

    it('finds an unread mention at format 3', async () => {
      expect(await channelUnread(bee, 'general', ref(first), { format: 3, me: ME, channelMentions: false, reactions: indexReactions([]), now: 1000 })).toEqual({
        unread: 3,
        mentioned: true,
      });
    });
  });

  it('is true when an unread message replies to me', async () => {
    expect(await unreadMentioned(bee, 'replied', undefined, ME, false)).toBe(true);
    expect(await unreadMentioned(bee, 'replied', { author: BO, id: '0000000000000000', at: 100 }, ME, false)).toBe(true);
  });

  it('is false for a reply to someone else, or once the reply is read', async () => {
    expect(await unreadMentioned(bee, 'others', undefined, ME, true)).toBe(false);
    expect(await unreadMentioned(bee, 'replied', { author: BO, id: '0000000000000001', at: 101 }, ME, false)).toBe(false);
  });

  it('ignores my own messages and deleted ones', async () => {
    expect(await unreadMentioned(bee, 'quiet', undefined, ME, true)).toBe(false);
    expect(await unreadMentioned(bee, 'gone', undefined, ME, true)).toBe(false);
  });
});

describe('channelUnread with reactions', () => {
  let dir: string;
  let store: Corestore;
  let bee: Hyperbee;
  const put = async (record: CircleMessageRecord) => {
    await bee.put(chatMessageKey(record.channel, record.position), record);
    await bee.put(chatIndexKey(record.channel, record.author, record.id), record.position);
    await bee.put(chatCountKey(record.channel), record.position + 1);
  };
  const mine = message(0, { author: ME, name: 'Me' });
  const mineToo = message(1, { author: ME, name: 'Me' });
  const gone = message(2, { author: ME, name: 'Me', deleted: 'author' });
  const read = { author: ME, id: gone.id, at: gone.at };
  const reaction = (target: CircleMessageRecord, identity: string, emoji: { e: string; at: number }[]) =>
    record(
      reactionRecordKey(target.channel, target.author, target.id),
      { channel: target.channel, author: target.author, id: target.id, name: 'Cy', emoji },
      { app: 'reactions', scope: 'member', identity }
    );
  const index = indexReactions([
    reaction(mine, CY, [
      { e: '👍', at: 500 },
      { e: '🎉', at: 600 },
    ]),
    reaction(mineToo, CY, [{ e: '👍', at: 50 }]),
    reaction(gone, BO, [{ e: '👍', at: 700 }]),
    reaction(mine, ME, [{ e: '👍', at: 800 }]),
  ]);
  const options = { format: 3, me: ME, channelMentions: false, reactions: index, now: 1000 };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'unread-reactions-'));
    store = new Corestore(dir);
    bee = new Hyperbee(store.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json' });
    await bee.ready();
    for (const r of [mine, mineToo, gone]) await put(r);
  });

  afterAll(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('counts others’ reactions to my messages after reactionsAt', async () => {
    const got = await channelUnread(bee, 'general', { ...read, reactionsAt: 100 }, options);
    expect(got).toEqual({ unread: 2, mentioned: false });
  });

  it('drops a reaction from the count when its reactor takes it back, and never marks a mention', async () => {
    const unread = (reactions: ReturnType<typeof indexReactions>) => channelUnread(bee, 'general', { ...read, reactionsAt: 100 }, { ...options, reactions });
    expect(await unread(indexReactions([reaction(mine, CY, [{ e: '👍', at: 500 }])]))).toEqual({ unread: 1, mentioned: false });
    // The reactor's record keeps another emoji, then holds none (a deleted record is the same as no record).
    expect(await unread(indexReactions([reaction(mine, CY, [{ e: '🎉', at: 600 }])]))).toEqual({ unread: 1, mentioned: false });
    expect(await unread(indexReactions([]))).toEqual({ unread: 0, mentioned: false });
  });

  it('leaves out a reaction whose at is more than two minutes ahead, and counts one a minute ahead', async () => {
    const unread = (at: number) =>
      channelUnread(bee, 'general', { ...read, reactionsAt: 100 }, { ...options, reactions: indexReactions([reaction(mine, CY, [{ e: '👍', at }])]) });
    expect(await unread(1000 + 60_000)).toEqual({ unread: 1, mentioned: false });
    expect(await unread(1000 + 120_000)).toEqual({ unread: 1, mentioned: false });
    expect(await unread(1000 + 120_001)).toEqual({ unread: 0, mentioned: false });
    expect(await unread(Number.MAX_SAFE_INTEGER)).toEqual({ unread: 0, mentioned: false });
  });

  it('does not count a reaction again once the read position has passed it', async () => {
    const reactions = indexReactions([reaction(mine, CY, [{ e: '👍', at: 1000 + 60_000 }])]);
    const unread = (reactionsAt: number) => channelUnread(bee, 'general', { ...read, reactionsAt }, { ...options, reactions });
    expect(await unread(100)).toEqual({ unread: 1, mentioned: false });
    expect(await unread(1000 + 60_000)).toEqual({ unread: 0, mentioned: false });
  });

  it('counts no reactions without reactionsAt', async () => {
    expect(await channelUnread(bee, 'general', read, options)).toEqual({ unread: 0, mentioned: false });
  });
});
