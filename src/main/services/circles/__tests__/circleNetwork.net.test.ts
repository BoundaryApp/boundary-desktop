import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CirclesSnapshot } from '../../../../shared/types/circles';
import { CircleNetwork } from '../circleNetwork';

/**
 * Three people on a HyperDHT testnet on 127.0.0.1, each with their own store and swarm, running
 * the real Holepunch modules. Each step waits for the runtime's own change events, not a timer.
 */

interface Person {
  net: CircleNetwork;
  /** Resolves once the snapshot satisfies `test`, checked on every change. */
  until(test: (snapshot: CirclesSnapshot) => boolean): Promise<CirclesSnapshot>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const people: Person[] = [];
const removed = new Map<Person, string[]>();

async function person(
  name: string,
  seeds = { identitySeed: crypto.randomBytes(32), deviceSeed: crypto.randomBytes(32) }
): Promise<Person> {
  const waiters = new Set<() => void>();
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    ...seeds,
    name,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: () => waiters.forEach((wake) => wake()),
    onRemoved: (key) => {
      removed.set(made, [...(removed.get(made) ?? []), key]);
      waiters.forEach((wake) => wake());
    },
  });
  await net.ready();
  const until = (test: (snapshot: CirclesSnapshot) => boolean) =>
    new Promise<CirclesSnapshot>((resolve) => {
      const check = () => {
        const snapshot = net.snapshot();
        if (!test(snapshot)) return;
        waiters.delete(check);
        resolve(snapshot);
      };
      waiters.add(check);
      check();
    });
  const made = { net, until };
  people.push(made);
  return made;
}

const circleOf = (snapshot: CirclesSnapshot, key: string) => snapshot.circles.find((circle) => circle.key === key);
const memberNamed = (snapshot: CirclesSnapshot, key: string, name: string) =>
  circleOf(snapshot, key)?.members.find((member) => member.name === name);

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-'));
});

afterAll(async () => {
  for (const { net } of people) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Circles over a local DHT', () => {
  let ada: Person;
  let bo: Person;
  let cy: Person;
  let key: string;

  it('creates a Circle with its creator as the only admin', async () => {
    ada = await person('Ada');
    const secrets = await ada.net.createCircle('Garden club');
    key = secrets.key!;
    expect(secrets.encryptionKey).toMatch(/^[0-9a-f]{64}$/);
    const circle = circleOf(ada.net.snapshot(), key)!;
    expect(circle.name).toBe('Garden club');
    expect(circle.myRole).toBe('admin');
    expect(circle.members).toEqual([expect.objectContaining({ name: 'Ada', role: 'admin', isMe: true, online: true })]);
  });

  it('admits an invitee while an admin is online, and both see each other online', async () => {
    bo = await person('Bo');
    const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    const joined = await bo.net.joinCircle(invite.code);
    expect(joined).toMatchObject({ key, name: 'Garden club' });

    const seenByBo = await bo.until((s) => circleOf(s, key)?.members.length === 2 && Boolean(memberNamed(s, key, 'Ada')?.online));
    expect(circleOf(seenByBo, key)!.myRole).toBe('member');
    await ada.until((s) => Boolean(memberNamed(s, key, 'Bo')?.online));
    // The same identity is visible across Circles (ADR 0032 §2).
    expect(memberNamed(ada.net.snapshot(), key, 'Bo')!.identity).toBe(bo.net.snapshot().identity);
    expect(circleOf(ada.net.snapshot(), key)!.invites).toEqual([
      expect.objectContaining({ id: invite.id, used: true, revoked: false }),
    ]);
  });

  it('refuses a used, an expired and a revoked invite', async () => {
    cy = await person('Cy');
    const used = circleOf(ada.net.snapshot(), key)!.invites[0];
    expect(used.used).toBe(true);

    const expired = await ada.net.createInvite(key, Date.now() - 1);
    await expect(cy.net.joinCircle(expired.code)).rejects.toThrow(/expired/);

    const revoked = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    await ada.net.revokeInvite(key, revoked.id);
    await expect(cy.net.joinCircle(revoked.code)).rejects.toThrow(/refused/);
    expect(circleOf(cy.net.snapshot(), key)).toBeUndefined();
  });

  it('ignores admin operations from a member', async () => {
    await bo.net.setRole(key, bo.net.snapshot().identity, 'admin');
    await bo.net.createInvite(key, Date.now() + 60_000);
    const circle = circleOf(bo.net.snapshot(), key)!;
    expect(circle.myRole).toBe('member');
    expect(circle.invites.every((invite) => invite.used || invite.revoked || invite.expires < Date.now())).toBe(true);
  });

  it('lets an admin promote a member, who can then invite', async () => {
    await ada.net.setRole(key, bo.net.snapshot().identity, 'admin');
    await bo.until((s) => circleOf(s, key)?.myRole === 'admin');
    const invite = await bo.net.createInvite(key, Date.now() + 60 * 60_000);
    await cy.net.joinCircle(invite.code);
    await ada.until((s) => circleOf(s, key)?.members.length === 3);
  });

  it('removes a member, who stops hearing from the Circle', async () => {
    await ada.net.removeMember(key, cy.net.snapshot().identity);
    await ada.until((s) => circleOf(s, key)?.members.length === 2);
    await bo.until((s) => circleOf(s, key)?.members.length === 2);
    await ada.until((s) => !memberNamed(s, key, 'Cy'));
    // An admin tells Cy, so the Circle closes on Cy's device and main can forget it.
    await cy.until((s) => !circleOf(s, key) && removed.has(cy));
    expect(removed.get(cy)).toEqual([key]);
  });

  it('revokes the open invites of an admin who is demoted', async () => {
    await ada.net.setRole(key, bo.net.snapshot().identity, 'admin');
    await bo.until((s) => circleOf(s, key)?.myRole === 'admin');
    const invite = await bo.net.createInvite(key, Date.now() + 60 * 60_000);
    await ada.until((s) => circleOf(s, key)?.invites.some((open) => open.id === invite.id) === true);
    await ada.net.setRole(key, bo.net.snapshot().identity, 'member');
    await bo.until((s) => circleOf(s, key)?.myRole === 'member');
    const dee = await person('Dee');
    await expect(dee.net.joinCircle(invite.code)).rejects.toThrow();
    await ada.net.setRole(key, bo.net.snapshot().identity, 'admin');
    await bo.until((s) => circleOf(s, key)?.myRole === 'admin');
  });

  it('tells a member removed while offline when they come back', async () => {
    const seeds = { identitySeed: crypto.randomBytes(32), deviceSeed: crypto.randomBytes(32) };
    const eve = await person('Eve', seeds);
    const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    const secrets = await eve.net.joinCircle(invite.code);
    await ada.until((s) => Boolean(memberNamed(s, key, 'Eve')?.online));
    const identity = eve.net.snapshot().identity;
    await eve.net.close();
    await ada.net.removeMember(key, identity);
    await ada.until((s) => !memberNamed(s, key, 'Eve'));

    const back = await person('Eve', seeds);
    await back.net.openCircle(secrets);
    await back.until((s) => !circleOf(s, key) && removed.has(back));
    expect(removed.get(back)).toEqual([key]);
  });

  it('keeps the last admin from leaving, and lets a member leave', async () => {
    await ada.net.setRole(key, bo.net.snapshot().identity, 'member');
    await expect(ada.net.leaveCircle(key)).rejects.toThrow(/last admin/);
    await bo.until((s) => circleOf(s, key)?.myRole === 'member');
    await bo.net.leaveCircle(key);
    expect(circleOf(bo.net.snapshot(), key)).toBeUndefined();
    await ada.until((s) => circleOf(s, key)?.members.length === 1);
  });
});
