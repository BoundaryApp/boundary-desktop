import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DirectEvent } from '../../../../shared/types/circles';
import { CircleNetwork } from '../circleNetwork';
import type { CircleSignal } from '../circleSignals';
import { DIRECT_TOPICS, DirectMessages, type DirectFile } from '../directMessages';
import type { CircleSecrets } from '../networkMessages';

/**
 * Direct messages between three people in one Circle on a HyperDHT testnet (ADR 0054). Ada
 * writes to Bo while Bo's device is closed, restarts her own device, and writes again; Bo's device
 * comes back and receives both once; an edit, a delete and Bo typing follow; Cy, online the whole
 * time, receives none of it. Each wait wakes on a DM event or a snapshot change, never on a timer.
 */

interface Person {
  net: CircleNetwork;
  dms: DirectMessages;
  identity: string;
  /** Every DM signal that reached this device, whoever it was for. */
  heard: CircleSignal[];
  /** Every DM event this device's service emitted. */
  events: DirectEvent[];
  until<T>(test: () => Promise<T | null> | T | null): Promise<T>;
  /** Close and reopen the network, keeping the DM service. */
  restart(secrets: CircleSecrets): Promise<void>;
  /** Close the network and the DM service, then start both again from this device's DM files. */
  restartDevice(secrets: CircleSecrets): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const people: Person[] = [];
let ids = 0;

async function person(name: string): Promise<Person> {
  const seeds = { identitySeed: crypto.randomBytes(32), deviceSeed: crypto.randomBytes(32) };
  const disk = new Map<string, DirectFile>();
  const waiters = new Set<() => void>();
  const wake = () => waiters.forEach((check) => check());
  const heard: CircleSignal[] = [];
  const events: DirectEvent[] = [];
  // Filled in below; the network's callbacks read it once it exists.
  const made = {} as Person;
  const start = async () => {
    const net = new CircleNetwork({
      storageDir: path.join(dir, name),
      ...seeds,
      name,
      bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
      onChange: () => {
        made.dms?.onPeopleChanged();
        wake();
      },
      onSignal: (signal) => {
        if (!signal.topic.startsWith('dm.')) return;
        heard.push(signal);
        void made.dms?.receive(signal.circle, signal.from, signal.topic, signal.payload);
      },
    });
    await net.ready();
    net.setSignalTopics(Object.values(DIRECT_TOPICS));
    return net;
  };
  const net = await start();
  const makeDms = () =>
    new DirectMessages({
      identity: () => made.identity,
      people: (key) => {
        const circle = made.net.snapshot().circles.find((c) => c.key === key);
        if (!circle || circle.myRole === null || !circle.writable) return null;
        return circle.members.filter((m) => !m.isMe).map(({ identity, name: who, online }) => ({ identity, name: who, online }));
      },
      // As main's sendCircleSignal: true while the network runs, whoever the signal reached.
      send: (key, topic, payload, to) => {
        made.net.sendSignal(key, topic, payload, to);
        return true;
      },
      keys: async () => [...disk.keys()],
      known: () => true,
      load: async (key) => (disk.has(key) ? structuredClone(disk.get(key)!) : null),
      save: async (key, file) => void disk.set(key, structuredClone(file)),
      remove: async (key) => void disk.delete(key),
      newId: () => (ids += 1).toString(16).padStart(16, '0'),
      now: () => Date.now(),
      emit: (event: DirectEvent) => {
        events.push(event);
        wake();
      },
      log: () => undefined,
    });
  const dms = makeDms();
  Object.assign(made, {
    net,
    dms,
    identity: net.identity.publicKey.toString('hex'),
    heard,
    events,
    until: <T,>(test: () => Promise<T | null> | T | null): Promise<T> =>
      new Promise<T>((resolve) => {
        const check = () => {
          void Promise.resolve(test()).then((value) => {
            if (value === null || value === undefined || value === false) return;
            waiters.delete(check);
            resolve(value as T);
          });
        };
        waiters.add(check);
        check();
      }),
    restart: async (secrets) => {
      made.net = await start();
      await made.net.openCircle(secrets);
    },
    restartDevice: async (secrets) => {
      made.dms.stop();
      await made.net.close();
      made.net = await start();
      made.dms = makeDms();
      await made.dms.start();
      await made.net.openCircle(secrets);
    },
  } satisfies Person);
  await dms.start();
  people.push(made);
  return made;
}

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-dms-'));
});

afterAll(async () => {
  for (const { net, dms } of people) {
    dms.stop();
    await net.close();
  }
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Direct messages over a local DHT', () => {
  it('waits for an offline device, delivers once, then edits and deletes, and nobody else hears it', async () => {
    const ada = await person('Ada');
    const bo = await person('Bo');
    const cy = await person('Cy');
    const adaSecrets = await ada.net.createCircle('Book Club');
    const key = adaSecrets.key!;
    const boSecrets = await bo.net.joinCircle((await ada.net.createInvite(key, Date.now() + 60_000)).code);
    await cy.net.joinCircle((await ada.net.createInvite(key, Date.now() + 60_000)).code);
    const everyoneOnline = (p: Person) => () => {
      const circle = p.net.snapshot().circles.find((c) => c.key === key);
      return circle?.writable && circle.members.length === 3 && circle.members.every((m) => m.online) ? true : null;
    };
    await Promise.all([ada.until(everyoneOnline(ada)), bo.until(everyoneOnline(bo)), cy.until(everyoneOnline(cy))]);

    // Bo's device closes; Ada sees Bo go and writes anyway.
    await bo.net.close();
    await ada.until(() => (ada.net.snapshot().circles.find((c) => c.key === key)?.members.find((m) => m.identity === bo.identity)?.online ? null : true));
    const { id } = await ada.dms.send(key, bo.identity, 'Pages 180 to 262.');
    expect((await ada.dms.messages(key, bo.identity)).messages[0]!.delivery).toBe('waiting');

    // Ada's device restarts before Bo is back: her outbox has to come back from her DM file.
    await ada.restartDevice(adaSecrets);
    await ada.until(() => (ada.net.snapshot().circles.find((c) => c.key === key)?.writable ? true : null));
    const { id: second } = await ada.dms.send(key, bo.identity, 'Bring snacks.');
    expect((await ada.dms.messages(key, bo.identity)).messages.map((m) => m.delivery)).toEqual(['waiting', 'waiting']);

    // Bo's device comes back: the outbox goes, Bo stores each once and acknowledges.
    await bo.restart(boSecrets);
    const received = await bo.until(async () => {
      const { messages } = await bo.dms.messages(key, ada.identity);
      return messages.length === 2 ? messages : null;
    });
    expect(received).toMatchObject([
      { id, text: 'Pages 180 to 262.', mine: false },
      { id: second, text: 'Bring snacks.', mine: false },
    ]);
    await ada.until(async () =>
      (await ada.dms.messages(key, bo.identity)).messages.every((m) => m.delivery === 'delivered') ? true : null
    );

    await ada.dms.edit(key, bo.identity, id, 'Pages 180 to 270.');
    await bo.until(async () => ((await bo.dms.messages(key, ada.identity)).messages[0]!.edited ? true : null));
    await ada.dms.delete(key, bo.identity, id);
    const gone = await bo.until(async () => {
      const [message] = (await bo.dms.messages(key, ada.identity)).messages;
      return message!.deleted ? message : null;
    });
    expect(gone).toMatchObject({ text: '', deleted: true });
    expect((await bo.dms.messages(key, ada.identity)).messages).toHaveLength(2);

    // Bo types; Ada's device hears it.
    bo.dms.typing(key, ada.identity);
    await ada.until(() => (ada.events.some((e) => e.kind === 'typing' && e.peer === bo.identity) ? true : null));

    // Cy was connected to both throughout and heard no DM signal, and has no conversation.
    expect(cy.heard).toEqual([]);
    expect(await cy.dms.conversations(key)).toEqual([]);
  });
});
