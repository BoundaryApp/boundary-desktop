import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Corestore from 'corestore';
import crypto from 'hypercore-crypto';
import Hyperbee from 'hyperbee';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CircleChatUpdate, CircleMessage } from '../../../../shared/types/circles';
import { ChatScan, type ChatReader } from '../circleChat';
import { indexReactions, reactionRecordKey } from '../circleReactions';
import { CircleNetwork } from '../circleNetwork';
import { chatIndexKey, chatMessageKey, type CircleMessageRecord } from '../circleOps';
import type { CircleSecrets } from '../networkMessages';

/**
 * Circle chat between three people over a HyperDHT testnet (Circle chats spec phase 2). Ada is the
 * only admin, so nothing confirms while she is offline. Waits on the runtime's change and chat
 * events, never on time.
 */

interface Person {
  name: string;
  identity: string;
  net: CircleNetwork;
  /** Each message as the chat events left it, by `author/id`. */
  messages: Map<string, CircleMessage>;
  /** Messages reported gone, by `author/id`. */
  gone: Set<string>;
  /** How many times each message was reported new. */
  added: Map<string, number>;
  until(test: () => boolean): Promise<void>;
  stop(): Promise<void>;
  restart(secrets: CircleSecrets): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const nets: CircleNetwork[] = [];
const ref = (message: { author: string; id: string }) => `${message.author}/${message.id}`;

async function person(name: string, supportedFormat?: number): Promise<Person> {
  const seeds = {
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
  };
  const waiters = new Set<() => void>();
  const wake = () => waiters.forEach((check) => check());
  const onChat = (update: CircleChatUpdate) => {
    for (const message of update.added) {
      made.added.set(ref(message), (made.added.get(ref(message)) ?? 0) + 1);
      made.messages.set(ref(message), message);
    }
    for (const message of update.changed) made.messages.set(ref(message), message);
    for (const gone of update.gone) {
      made.messages.delete(ref(gone));
      made.gone.add(ref(gone));
    }
    wake();
  };
  const start = async () => {
    const net = new CircleNetwork({
      storageDir: path.join(dir, name),
      ...seeds,
      name,
      supportedFormat,
      ackInterval: 500,
      bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
      onChange: wake,
      onChat,
    });
    await net.ready();
    nets.push(net);
    return net;
  };
  const net = await start();
  const made: Person = {
    name,
    identity: net.snapshot().identity,
    net,
    messages: new Map(),
    gone: new Set(),
    added: new Map(),
    until: (test) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!test()) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      }),
    stop: () => made.net.close(),
    restart: async (secrets) => {
      made.net = await start();
      await made.net.openCircle(secrets);
    },
  };
  return made;
}

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-chat-'));
});

afterAll(async () => {
  for (const net of nets) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Circle chat', () => {
  let ada: Person;
  let bo: Person;
  let cy: Person;
  let key: string;
  const secrets = new Map<string, CircleSecrets>();

  const confirmed = (p: Person) => {
    const { length, signedLength } = p.net.confirmation(key);
    return signedLength >= length;
  };
  const online = (p: Person, name: string) =>
    Boolean(p.net.snapshot().circles[0]?.members.find((member) => member.name === name)?.online);
  const holds = (p: Person, text: string, test: (message: CircleMessage) => boolean = () => true) =>
    [...p.messages.values()].some((message) => message.text === text && test(message));

  it('sets up a Circle with one admin and two members', async () => {
    ada = await person('Ada');
    const created = await ada.net.createCircle('Allotment');
    key = created.key!;
    secrets.set('Ada', created);
    for (const name of ['Bo', 'Cy']) {
      const p = await person(name);
      const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
      secrets.set(name, await p.net.joinCircle(invite.code));
      if (name === 'Bo') bo = p;
      else cy = p;
    }
    for (const p of [ada, bo, cy]) await p.until(() => (p.net.snapshot().circles[0]?.members.length ?? 0) === 3 && confirmed(p));
  });

  it('posts, reads back in order and pages older messages', async () => {
    const first = await ada.net.postMessage(key, 'general', 'First');
    const second = await bo.net.postMessage(key, 'general', 'Second');
    await cy.until(() => holds(cy, 'First') && holds(cy, 'Second'));
    await cy.until(() => holds(cy, 'Second', (message) => message.confirmed));

    const latest = await cy.net.listMessages(key, 'general', { limit: 1 });
    expect(latest.messages.map((message) => message.text)).toEqual(['Second']);
    expect(latest.more).toBe(true);
    const older = await cy.net.listMessages(key, 'general', {
      before: { author: bo.identity, id: second },
      limit: 10,
    });
    expect(older).toMatchObject({
      messages: [
        {
          text: 'First',
          author: ada.identity,
          id: first,
          name: 'Ada',
          mine: false,
        },
      ],
      more: false,
    });

    const [general] = await cy.net.listChannels(key, {
      general: { author: ada.identity, id: first, at: 0 },
    }, true);
    expect(general).toEqual({ id: 'general', name: 'General', unread: 1, mentioned: false });
    expect((await cy.net.listChannels(key, {}, true))[0]?.unread).toBe(2);
  });

  it('reports edits and deletes, and refuses what isn’t yours', async () => {
    const id = await bo.net.postMessage(key, 'general', 'Draft');
    await cy.until(() => holds(cy, 'Draft'));
    await expect(cy.net.editMessage(key, 'general', id, 'Hijacked')).rejects.toThrow('isn’t yours');
    await expect(cy.net.deleteMessage(key, 'general', bo.identity, id)).rejects.toThrow('author or an admin');
    await expect(bo.net.postMessage(key, 'nowhere', 'Hi')).rejects.toThrow('isn’t in this Circle');
    await expect(bo.net.postMessage(key, 'general', '   ')).rejects.toThrow('needs text');

    await bo.net.editMessage(key, 'general', id, 'Final');
    await cy.until(() => holds(cy, 'Final', (message) => message.edited));
    await ada.net.deleteMessage(key, 'general', bo.identity, id);
    await cy.until(() => cy.messages.get(`${bo.identity}/${id}`)?.deleted === 'admin');
    expect(cy.added.get(`${bo.identity}/${id}`)).toBe(1);
  });

  it('shows messages unconfirmed while no admin is online, and confirms them when one returns', async () => {
    await ada.stop();
    await bo.until(() => !online(bo, 'Ada'));
    await cy.until(() => !online(cy, 'Ada'));

    await bo.net.postMessage(key, 'general', 'Anyone there?');
    await cy.until(() => holds(cy, 'Anyone there?'));
    expect(holds(cy, 'Anyone there?', (message) => !message.confirmed)).toBe(true);
    expect(holds(bo, 'Anyone there?', (message) => !message.confirmed && message.mine)).toBe(true);

    await ada.restart(secrets.get('Ada')!);
    await bo.until(() => holds(bo, 'Anyone there?', (message) => message.confirmed));
    await cy.until(() => holds(cy, 'Anyone there?', (message) => message.confirmed));
  });

  it('reports a message gone when its author’s removal settles before it', async () => {
    // Ada removes Cy while neither member is online, so the removal is confirmed before Cy
    // knows. Cy then posts to Bo with Ada away; once Ada is back, the post orders after it.
    await bo.stop();
    await cy.stop();
    await ada.until(() => !online(ada, 'Bo') && !online(ada, 'Cy'));
    await ada.net.removeMember(key, cy.identity);
    await ada.until(() => confirmed(ada));
    await ada.stop();

    await bo.restart(secrets.get('Bo')!);
    await cy.restart(secrets.get('Cy')!);
    await bo.until(() => online(bo, 'Cy'));
    const id = await cy.net.postMessage(key, 'general', 'Still here');
    await bo.until(() => holds(bo, 'Still here', (message) => !message.confirmed));

    await ada.restart(secrets.get('Ada')!);
    await bo.until(() => bo.gone.has(`${cy.identity}/${id}`));
    expect(holds(bo, 'Still here')).toBe(false);
    const { messages } = await bo.net.listMessages(key, 'general', {
      limit: 50,
    });
    expect(messages.some((message) => message.id === id)).toBe(false);
  });

  describe('reactions', () => {
    const reactions = (p: Person, id: string) => p.messages.get(`${ada.identity}/${id}`)?.reactions ?? [];
    const recordOf = async (p: Person, id: string) =>
      (await p.net.listRecords(key, 'reactions')).find((r) => r.identity === p.identity && (r.value as { id: string }).id === id);

    it('reacts, shows the reaction to others, and takes it back', async () => {
      const id = await ada.net.postMessage(key, 'general', 'React to this');
      await bo.until(() => holds(bo, 'React to this'));
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '👍', true);
      await ada.until(() => reactions(ada, id).length === 1);
      expect(reactions(ada, id)).toMatchObject([{ emoji: '👍', count: 1, mine: false, people: [{ identity: bo.identity, name: 'Bo' }] }]);
      const listed = (await ada.net.listMessages(key, 'general', { limit: 50 })).messages.find((m) => m.id === id);
      expect(listed?.reactions).toMatchObject([{ count: 1, mine: false }]);
      const before = (await bo.net.listRecords(key, 'reactions')).length;
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '👍', true);
      expect((await bo.net.listRecords(key, 'reactions')).length).toBe(before);

      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '👍', false);
      await ada.until(() => reactions(ada, id).length === 0);
      expect(await recordOf(bo, id)).toBeUndefined();
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '👍', false);
    });

    it('refuses a 21st emoji and a reaction to a deleted message', async () => {
      const id = await ada.net.postMessage(key, 'general', 'Many reactions');
      await bo.until(() => holds(bo, 'Many reactions'));
      const ref = { author: ada.identity, id };
      const emoji = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋'];
      for (const e of emoji) await bo.net.reactMessage(key, 'general', ref, e, true);
      await expect(bo.net.reactMessage(key, 'general', ref, '😛', true)).rejects.toThrow('You’ve used 20 reactions on this message');
      await expect(bo.net.reactMessage(key, 'general', ref, 'ab', true)).rejects.toThrow('That isn’t an emoji.');
      await expect(bo.net.reactMessage(key, 'general', { author: ada.identity, id: 'f'.repeat(32) }, '👍', true)).rejects.toThrow('isn’t in this channel');

      await ada.net.deleteMessage(key, 'general', ada.identity, id);
      await bo.until(() => bo.messages.get(`${ada.identity}/${id}`)?.deleted === 'author');
      await expect(bo.net.reactMessage(key, 'general', ref, '👍', true)).rejects.toThrow('That message was deleted.');
    });

    it('builds on the record another device of the same member already wrote', async () => {
      // The harness has no second device of one member, so the first device's write is made
      // through the record API with the same key and value shape, and the toggle must extend it.
      const id = await ada.net.postMessage(key, 'general', 'Two devices');
      await bo.until(() => holds(bo, 'Two devices'));
      const record = reactionRecordKey('general', ada.identity, id);
      const at = Date.now();
      const first = { channel: 'general', author: ada.identity, id, name: 'Bo', emoji: [{ e: '👍', at }] };
      await bo.net.setRecord(key, 'reactions', 'member', record, first, { keep: true });
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '😂', true);
      expect((await recordOf(bo, id))?.value).toMatchObject({ emoji: [{ e: '👍', at }, { e: '😂' }] });
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '👍', false);
      expect((await recordOf(bo, id))?.value).toMatchObject({ emoji: [{ e: '😂' }] });
    });

    it('keeps both reactions when two toggles for different emoji are in flight at once', async () => {
      const id = await ada.net.postMessage(key, 'general', 'Quick double tap');
      await bo.until(() => holds(bo, 'Quick double tap'));
      const ref = { author: ada.identity, id };
      await Promise.all([bo.net.reactMessage(key, 'general', ref, '👍', true), bo.net.reactMessage(key, 'general', ref, '😂', true)]);
      const emoji = ((await recordOf(bo, id))?.value as { emoji: { e: string }[] }).emoji.map((x) => x.e);
      expect(emoji.sort()).toEqual(['👍', '😂'].sort());
    });

    it('runs a toggle queued behind one that was refused', async () => {
      const id = await ada.net.postMessage(key, 'general', 'Refused then fine');
      await bo.until(() => holds(bo, 'Refused then fine'));
      const ref = { author: ada.identity, id };
      const [refused, ok] = await Promise.allSettled([
        bo.net.reactMessage(key, 'general', ref, 'ab', true),
        bo.net.reactMessage(key, 'general', ref, '🎉', true),
      ]);
      expect(refused.status).toBe('rejected');
      expect(ok.status).toBe('fulfilled');
      expect((await recordOf(bo, id))?.value).toMatchObject({ emoji: [{ e: '🎉' }] });
    });

    it('reports a reaction on the next scan when the scan that held it failed', async () => {
      const first = await ada.net.postMessage(key, 'general', 'Scan fails here');
      const second = await ada.net.postMessage(key, 'general', 'Scan works here');
      await bo.until(() => holds(bo, 'Scan works here'));
      const open = (ada.net as unknown as { circles: Map<string, { chat: { scan: (...args: unknown[]) => Promise<unknown> } }> }).circles.get(key)!;
      const real = open.chat.scan.bind(open.chat);
      let failed = false;
      open.chat.scan = async (...args) => {
        if (!failed) {
          failed = true;
          throw new Error('scan failed');
        }
        return real(...args);
      };
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id: first }, '👍', true);
      await ada.until(() => failed);
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id: second }, '👍', true);
      await ada.until(() => reactions(ada, second).length === 1);
      await ada.until(() => reactions(ada, first).length === 1);
    });

    it('keeps a removed member’s reaction, marked left', async () => {
      const id = await ada.net.postMessage(key, 'general', 'Before Bo goes');
      await bo.until(() => holds(bo, 'Before Bo goes'));
      await bo.net.reactMessage(key, 'general', { author: ada.identity, id }, '🙏', true);
      await ada.until(() => reactions(ada, id).length === 1);
      await ada.net.removeMember(key, bo.identity);
      await ada.until(() => (ada.net.snapshot().circles[0]?.members.length ?? 0) === 1);
      const listed = (await ada.net.listMessages(key, 'general', { limit: 50 })).messages.find((m) => m.id === id);
      expect(listed?.reactions).toMatchObject([{ emoji: '🙏', count: 1, people: [{ identity: bo.identity, left: true }] }]);
    });
  });
});

describe('ChatScan on one view', () => {
  const ME = 'aa'.repeat(32);
  const OTHER = 'bb'.repeat(32);
  let store: Corestore;
  let bee: Hyperbee;
  const channels = new Set(['general']);
  const reader = (signedLength: number): ChatReader => ({
    circleKey: 'k',
    me: ME,
    signedLength,
    reactions: indexReactions([]),
    members: new Set<string>(),
  });
  const record = (position: number, id: string, text: string, extra: Partial<CircleMessageRecord> = {}): CircleMessageRecord => ({
    channel: 'general',
    position,
    author: OTHER,
    id,
    name: 'Bo',
    text,
    at: position,
    edited: false,
    deleted: null,
    ...extra,
  });
  const put = (message: CircleMessageRecord) => bee.put(chatMessageKey(message.channel, message.position), message);
  const summary = (updates: CircleChatUpdate[]) =>
    updates.map(({ channel, added, changed, gone }) => ({
      channel,
      added: added.map((message) => `${message.text}${message.confirmed ? '' : '?'}`),
      changed: changed.map((message) => `${message.text}${message.confirmed ? '' : '?'}`),
      gone: gone.map((message) => message.id),
    }));

  beforeAll(async () => {
    store = new Corestore(path.join(dir, 'scan'));
    bee = new Hyperbee(store.get({ name: 'view' }), {
      keyEncoding: 'utf-8',
      valueEncoding: 'json',
    });
    await bee.ready();
  });

  afterAll(() => store.close());

  it('reports nothing at the first scan, then each new, confirmed, edited and settled-away message', async () => {
    const scan = new ChatScan();
    await put(record(0, '00000000000000a0', 'Old'));
    expect(await scan.scan(bee, channels, reader(bee.core.length))).toEqual([]);
    const confirmedOld = bee.core.length;

    await put(record(1, '00000000000000a1', 'New'));
    await put(record(2, '00000000000000a2', 'Doomed', { author: ME }));
    expect(summary(await scan.scan(bee, channels, reader(confirmedOld)))).toEqual([
      { channel: 'general', added: ['New?', 'Doomed?'], changed: [], gone: [] },
    ]);
    expect(await scan.scan(bee, channels, reader(confirmedOld))).toEqual([]);

    // Confirming "New": its block falls below signedLength. "Doomed" is still unconfirmed.
    const confirmedNew = bee.core.length - 1;
    expect(summary(await scan.scan(bee, channels, reader(confirmedNew)))).toEqual([
      { channel: 'general', added: [], changed: ['New'], gone: [] },
    ]);

    await put(record(0, '00000000000000a0', 'Old, edited', { edited: true }));
    await bee.del(chatMessageKey('general', 2));
    expect(summary(await scan.scan(bee, channels, reader(confirmedNew)))).toEqual([
      {
        channel: 'general',
        added: [],
        changed: ['Old, edited?'],
        gone: ['00000000000000a2'],
      },
    ]);
  });

  it('leaves out channels the Circle doesn’t have', async () => {
    const scan = new ChatScan();
    const signed = bee.core.length;
    await scan.scan(bee, channels, reader(signed));
    await put(record(0, '00000000000000b0', 'Stray', { channel: 'nowhere' }));
    expect(await scan.scan(bee, channels, reader(signed))).toEqual([]);
  });

  it('reports a message changed when only its reactions changed', async () => {
    const scan = new ChatScan();
    await put(record(10, '00000000000000c0', 'React to me'));
    await bee.put(chatIndexKey('general', OTHER, '00000000000000c0'), 10);
    const signed = bee.core.length;
    const ref = { channel: 'general', author: OTHER, id: '00000000000000c0' };
    expect(await scan.scan(bee, channels, reader(signed), [ref])).toEqual([]);
    const updates = await scan.scan(bee, channels, reader(signed), [ref]);
    expect(summary(updates)).toEqual([{ channel: 'general', added: [], changed: ['React to me'], gone: [] }]);
  });

  it('drops a reaction ref whose message isn’t in the view', async () => {
    const scan = new ChatScan();
    const signed = bee.core.length;
    await scan.scan(bee, channels, reader(signed));
    const ghost = { channel: 'general', author: OTHER, id: '00000000000000ff' };
    expect(await scan.scan(bee, channels, reader(signed), [ghost])).toEqual([]);
  });
});

describe('channel listing at format 3', () => {
  it('marks a channel with an unread mention of the reader', async () => {
    // A build that applies `mentions` stands in through `supportedFormat`; new Circles start at it.
    const di = await person('Di', 3);
    const ed = await person('Ed', 3);
    const created = await di.net.createCircle('Orchard');
    const key = created.key!;
    const invite = await di.net.createInvite(key, Date.now() + 60 * 60_000);
    await ed.net.joinCircle(invite.code);
    for (const p of [di, ed]) await p.until(() => (p.net.snapshot().circles[0]?.members.length ?? 0) === 2);
    expect(di.net.snapshot().circles[0]?.format).toBe(3);

    const plain = await di.net.postMessage(key, 'general', 'Picking on Saturday');
    await di.net.postMessage(key, 'general', '@Ed can you bring ladders?', { mentions: { members: [ed.identity] } });
    await ed.until(() => [...ed.messages.values()].some((message) => message.mentions !== null));

    expect((await ed.net.listChannels(key, {}, false))[0]).toEqual({ id: 'general', name: 'General', unread: 2, mentioned: true });
    const read = { general: { author: di.identity, id: plain, at: 0 } };
    expect((await ed.net.listChannels(key, read, false))[0]).toMatchObject({ unread: 1, mentioned: true });
    // Di's own post never mentions Di.
    expect((await di.net.listChannels(key, {}, true))[0]).toMatchObject({ unread: 2, mentioned: false });
  });

  it('carries a reply to the other member at format 3 and refuses one at format 2', async () => {
    const fay = await person('Fay', 3);
    const gus = await person('Gus', 3);
    const created = await fay.net.createCircle('Greenhouse');
    const key = created.key!;
    const invite = await fay.net.createInvite(key, Date.now() + 60 * 60_000);
    await gus.net.joinCircle(invite.code);
    for (const p of [fay, gus]) await p.until(() => (p.net.snapshot().circles[0]?.members.length ?? 0) === 2);

    const first = await fay.net.postMessage(key, 'general', 'Who has the hose?');
    const ref = { author: fay.identity, id: first };
    const answer = await gus.net.postMessage(key, 'general', 'Me', { reply: ref });
    const seen = () => [...fay.messages.values()].find((message) => message.id === answer);
    await fay.until(() => seen() !== undefined);
    expect(seen()?.reply).toEqual(ref);
    expect(await fay.net.getMessage(key, 'general', { author: gus.identity, id: answer })).toMatchObject({ text: 'Me', reply: ref });
    expect(await fay.net.getMessage(key, 'general', { author: gus.identity, id: 'f'.repeat(32) })).toBeNull();

    const old = await person('Hal', 2);
    const small = await old.net.createCircle('Shed');
    await expect(old.net.postMessage(small.key!, 'general', 'Hi', { reply: ref })).rejects.toThrow('Replies need this Circle to be updated first.');
  });
});
