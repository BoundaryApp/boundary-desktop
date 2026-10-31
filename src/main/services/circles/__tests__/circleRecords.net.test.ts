import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircleNetwork } from '../circleNetwork';
import type { CircleRecordChange } from '../networkMessages';

/**
 * Ada (admin), Bo and Cy in one Circle on a HyperDHT testnet. Only Ada and Bo listen to the
 * `profile` app, so Cy shows that a build ignoring an app still replicates its records.
 */

interface Person {
  net: CircleNetwork;
  identity: string;
  changes: CircleRecordChange[];
  until(test: () => boolean): Promise<void>;
  /** Resolves on the next change to anything this person sees. */
  nextChange(): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let ada: Person;
let bo: Person;
let cy: Person;
let key: string;
const people: Person[] = [];

async function person(name: string): Promise<Person> {
  const waiters = new Set<() => void>();
  const changes: CircleRecordChange[] = [];
  const wake = () => waiters.forEach((check) => check());
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    ackInterval: 500,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: wake,
    onRecord: (change) => {
      changes.push(change);
      wake();
    },
  });
  await net.ready();
  const made: Person = {
    net,
    identity: net.snapshot().identity,
    changes,
    nextChange: () =>
      new Promise<void>((resolve) => {
        const check = () => {
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      }),
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
  };
  people.push(made);
  return made;
}

const holds = (p: Person, change: (c: CircleRecordChange) => boolean) => p.changes.some(change);

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-records-'));
  ada = await person('ada');
  bo = await person('bo');
  cy = await person('cy');
  key = (await ada.net.createCircle('Allotment')).key!;
  for (const joiner of [bo, cy]) {
    const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    await joiner.net.joinCircle(invite.code);
  }
  ada.net.setRecordApps(['profile', 'settings']);
  bo.net.setRecordApps(['profile', 'settings']);
});

afterAll(async () => {
  for (const { net } of people) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Circle records', () => {
  it('reaches every member, and a build ignoring the app still holds it', async () => {
    await bo.net.setRecord(key, 'profile', 'member', 'bio', { text: 'Beans' });
    await ada.until(() => holds(ada, (c) => c.key === 'bio' && c.identity === bo.identity && !c.deleted));
    const change = ada.changes.find((c) => c.key === 'bio')!;
    expect(change).toMatchObject({ circleKey: key, app: 'profile', scope: 'member', value: { text: 'Beans' } });

    expect(cy.changes).toEqual([]);
    await cy.until(() => (cy.net.snapshot().circles[0]?.members.length ?? 0) === 3);
    let records = await cy.net.listRecords(key, 'profile');
    while (records.length === 0) {
      await cy.nextChange();
      records = await cy.net.listRecords(key, 'profile');
    }
    expect(records[0].value).toEqual({ text: 'Beans' });
  });

  it('reports a record as confirmed once the admins have ordered it', async () => {
    // A member's own write can't be confirmed until Ada, the only admin, has acked it.
    await bo.net.setRecord(key, 'profile', 'member', 'note', 'first');
    expect(bo.changes.find((c) => c.key === 'note')?.confirmed).toBe(false);
    await bo.until(() => holds(bo, (c) => c.key === 'note' && c.confirmed));
    expect((await bo.net.listRecords(key, 'profile')).find((r) => r.key === 'note')?.confirmed).toBe(true);
  });

  it('refuses before appending what this device may not write', async () => {
    await expect(bo.net.setRecord(key, 'settings', 'circle', 'topic', 'beans')).rejects.toThrow('Only admins');
    await expect(bo.net.setRecord(key, 'a/b', 'member', 'k', 1)).rejects.toThrow('record name');
    await expect(bo.net.setRecord(key, 'profile', 'member', 'k', 'x'.repeat(17_000))).rejects.toThrow('too long');
    await expect(bo.net.setRecord(key, 'profile', 'member', 'k', undefined)).rejects.toThrow('too long');
  });

  it('reports a deletion', async () => {
    await ada.net.setRecord(key, 'settings', 'circle', 'topic', 'peas');
    await bo.until(() => holds(bo, (c) => c.key === 'topic' && !c.deleted));
    await ada.net.deleteRecord(key, 'settings', 'circle', 'topic');
    await bo.until(() => holds(bo, (c) => c.key === 'topic' && c.deleted && c.value === null));
    expect(await bo.net.listRecords(key, 'settings')).toEqual([]);
  });

  it('clears a removed member’s records for everyone', async () => {
    await ada.net.removeMember(key, bo.identity);
    await ada.until(() => holds(ada, (c) => c.key === 'bio' && c.deleted) && holds(ada, (c) => c.key === 'note' && c.deleted));
    expect(await ada.net.listRecords(key, 'profile')).toEqual([]);
  });
});
