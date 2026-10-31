import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CirclesSnapshot } from '../../../../shared/types/circles';
import { CircleNetwork } from '../circleNetwork';
import { encodeSignal, type CircleSignal } from '../circleSignals';
import type { SignalLink } from '../signalChannel';

/**
 * Three people in two Circles on a HyperDHT testnet, with Ada and Bo in both and Cy only in the
 * first, so every pair stays connected through the first Circle. Signals are ordered per
 * connection, so a test proves something didn't arrive by sending a later `fence` signal on the
 * same connection and checking what came before it. No test waits on a timer.
 */

interface Person {
  net: CircleNetwork;
  identity: string;
  device: string;
  received: CircleSignal[];
  /** Resolves once the snapshot satisfies `test`, checked on every change. */
  until(test: (snapshot: CirclesSnapshot) => boolean): Promise<CirclesSnapshot>;
  /** Resolves once a signal on `fence` has arrived from anyone since the last call. */
  fenced(): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const people: Person[] = [];

async function person(name: string): Promise<Person> {
  const waiters = new Set<() => void>();
  const received: CircleSignal[] = [];
  let fences = 0;
  let fenceWaiter: (() => void) | null = null;
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: () => waiters.forEach((wake) => wake()),
    onSignal: (signal) => {
      if (signal.topic !== 'fence') return void received.push(signal);
      fences += 1;
      fenceWaiter?.();
    },
  });
  await net.ready();
  net.setSignalTopics(['typing', 'fence']);
  const made: Person = {
    net,
    identity: net.identity.publicKey.toString('hex'),
    device: net.device.publicKey.toString('hex'),
    received,
    until: (test) =>
      new Promise((resolve) => {
        const check = () => {
          const snapshot = net.snapshot();
          if (!test(snapshot)) return;
          waiters.delete(check);
          resolve(snapshot);
        };
        waiters.add(check);
        check();
      }),
    fenced: () =>
      new Promise((resolve) => {
        const check = () => {
          if (fences === 0) return;
          fences -= 1;
          fenceWaiter = null;
          resolve();
        };
        fenceWaiter = check;
        check();
      }),
  };
  people.push(made);
  return made;
}

/** The link `from` holds to `to`, for sending what `sendSignal` would refuse to. */
function linkTo(from: Person, to: Person): SignalLink {
  const peers = (from.net as unknown as { peers: Map<string, { signals: SignalLink | null }> }).peers;
  return peers.get(to.device)!.signals!;
}

const signalStats = (who: Person) =>
  who.net.diagnostics().signals as { dropped: Record<string, number>; received: Record<string, { messages: number }> };

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-signals-'));
});

afterAll(async () => {
  for (const { net } of people) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Peer signals over a local DHT', () => {
  let ada: Person;
  let bo: Person;
  let cy: Person;
  let first: string;
  let second: string;

  /** Fences `to` with a signal from `from`, after everything `from` has sent it so far. */
  async function fence(from: Person, to: Person, circle: string): Promise<void> {
    expect(from.net.sendSignal(circle, 'fence', {}, to.identity)).toBe(1);
    await to.fenced();
  }

  const onlineIn = (snapshot: CirclesSnapshot, key: string) =>
    snapshot.circles.find((circle) => circle.key === key)?.members.filter((member) => member.online).length ?? 0;

  beforeAll(async () => {
    ada = await person('Ada');
    bo = await person('Bo');
    cy = await person('Cy');
    first = (await ada.net.createCircle('First')).key!;
    second = (await ada.net.createCircle('Second')).key!;
    await bo.net.joinCircle((await ada.net.createInvite(first, Date.now() + 60_000)).code);
    await cy.net.joinCircle((await ada.net.createInvite(first, Date.now() + 60_000)).code);
    await bo.net.joinCircle((await ada.net.createInvite(second, Date.now() + 60_000)).code);
    await Promise.all([
      ada.until((s) => onlineIn(s, first) === 3 && onlineIn(s, second) === 2),
      bo.until((s) => onlineIn(s, first) === 3 && onlineIn(s, second) === 2),
      cy.until((s) => onlineIn(s, first) === 3),
    ]);
  });

  it('reaches only the members of its Circle, naming the sender from the connection', async () => {
    expect(ada.net.sendSignal(second, 'typing', { on: true })).toBe(1);
    await fence(ada, bo, second);
    await fence(ada, cy, first);
    expect(bo.received).toEqual([{ circle: second, from: ada.identity, topic: 'typing', payload: { on: true } }]);
    expect(cy.received).toEqual([]);
    bo.received.length = 0;
  });

  it('goes to one member when addressed', async () => {
    expect(ada.net.sendSignal(first, 'typing', 'for cy', cy.identity)).toBe(1);
    await fence(ada, cy, first);
    await fence(ada, bo, first);
    expect(cy.received.map((signal) => signal.payload)).toEqual(['for cy']);
    expect(bo.received).toEqual([]);
    cy.received.length = 0;
  });

  it('keeps messages in order', async () => {
    for (let index = 0; index < 40; index++) ada.net.sendSignal(first, 'typing', index, bo.identity);
    await fence(ada, bo, first);
    expect(bo.received.map((signal) => signal.payload)).toEqual(Array.from({ length: 40 }, (_, index) => index));
    bo.received.length = 0;
  });

  it('refuses a signal naming a Circle its sender isn’t in', async () => {
    const before = signalStats(ada).dropped['not-member'] ?? 0;
    linkTo(cy, ada).send(encodeSignal({ circle: second, topic: 'typing', payload: 'forged' }));
    await fence(cy, ada, first);
    expect(ada.received).toEqual([]);
    expect(signalStats(ada).dropped['not-member']).toBe(before + 1);
  });

  it('ignores an unknown topic and keeps the channel working', async () => {
    const before = signalStats(ada).dropped['unknown-topic'] ?? 0;
    expect(bo.net.sendSignal(first, 'not-listened-to', 'x', ada.identity)).toBe(1);
    await fence(bo, ada, first);
    expect(ada.received).toEqual([]);
    expect(signalStats(ada).dropped['unknown-topic']).toBe(before + 1);
    expect(Object.keys(signalStats(ada).received)).not.toContain('not-listened-to');
  });

  it('sends a removed member nothing, and takes nothing from them, while another Circle keeps them connected', async () => {
    await ada.net.removeMember(second, bo.identity);
    // An admin's notice closes the Circle on the removed device.
    await bo.until((s) => !s.circles.some((circle) => circle.key === second));
    expect(ada.net.sendSignal(second, 'typing', 'gone')).toBe(0);
    await fence(ada, bo, first);
    expect(bo.received).toEqual([]);

    const before = signalStats(ada).dropped['not-member'] ?? 0;
    linkTo(bo, ada).send(encodeSignal({ circle: second, topic: 'typing', payload: 'forged' }));
    await fence(bo, ada, first);
    expect(ada.received).toEqual([]);
    expect(signalStats(ada).dropped['not-member']).toBe(before + 1);
  });

  it('keeps payloads, keys and names out of diagnostics', () => {
    const record = JSON.stringify(ada.net.diagnostics().signals);
    for (const secret of ['for cy', 'forged', 'gone', first, ada.identity, 'not-listened-to']) expect(record).not.toContain(secret);
    expect(record).toContain('typing');
  });
});
