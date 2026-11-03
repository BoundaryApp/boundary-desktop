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
import { CircleNetwork } from '../circleNetwork';
import { chatMessageKey, type CircleMessageRecord } from '../circleOps';
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

async function person(name: string): Promise<Person> {
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
    });
    expect(general).toEqual({ id: 'general', name: 'General', unread: 1 });
    expect((await cy.net.listChannels(key, {}))[0]?.unread).toBe(2);
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
});
