import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircleNetwork } from '../circleNetwork';
import type { CircleSecrets } from '../networkMessages';

/**
 * Two builds in one Circle on a HyperDHT testnet (ADR 0038). A later build stands in through
 * `supportedFormat`. Each test ends with both people on the later build, holding the same view,
 * because that recovery is what stopping gives over skipping an operation.
 */

interface Person {
  net: CircleNetwork;
  until(test: () => boolean): Promise<void>;
  /** Quit and start again on a build with this format, from the same storage. */
  update(format: number, secrets: CircleSecrets): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const nets: CircleNetwork[] = [];

async function person(name: string, format: number): Promise<Person> {
  const seeds = { identitySeed: crypto.randomBytes(32), deviceSeed: crypto.randomBytes(32) };
  const waiters = new Set<() => void>();
  const start = async (supportedFormat: number) => {
    const net = new CircleNetwork({
      storageDir: path.join(dir, name),
      ...seeds,
      name,
      supportedFormat,
      ackInterval: 500,
      bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
      onChange: () => waiters.forEach((wake) => wake()),
    });
    await net.ready();
    nets.push(net);
    return net;
  };
  const made: Person = {
    net: await start(format),
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
    update: async (next, secrets) => {
      await made.net.close();
      made.net = await start(next);
      await made.net.openCircle(secrets);
    },
  };
  return made;
}

const circleOf = (p: Person, key: string) => p.net.snapshot().circles.find((circle) => circle.key === key);
const invites = (p: Person, key: string) => (circleOf(p, key)?.invites ?? []).map((invite) => invite.id).sort();

async function pair(prefix: string) {
  const ada = await person(`${prefix}-ada`, 1);
  const bo = await person(`${prefix}-bo`, 1);
  const adaSecrets = await ada.net.createCircle('Allotment');
  const key = adaSecrets.key!;
  const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
  const boSecrets = await bo.net.joinCircle(invite.code);
  return { ada, bo, key, adaSecrets, boSecrets };
}

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-upgrade-'));
});

afterAll(async () => {
  for (const net of nets) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('a Circle that moves to a later format', () => {
  it('stops a member on the older build, who catches up after updating', async () => {
    const { ada, bo, key, adaSecrets, boSecrets } = await pair('member');
    await ada.update(2, adaSecrets);
    await ada.net.setFormat(key, 2);
    await bo.until(() => Boolean(circleOf(bo, key)?.needsUpdate));
    await expect(bo.net.createInvite(key, Date.now() + 60_000)).rejects.toThrow();

    const later = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    expect(invites(bo, key)).not.toContain(later.id);

    await bo.update(2, boSecrets);
    await bo.until(() => invites(bo, key).includes(later.id));
    expect(circleOf(bo, key)?.needsUpdate).toBe(false);
    expect(invites(bo, key)).toEqual(invites(ada, key));
  });

  it('stops an admin on the older build, and confirmation resumes after updating', async () => {
    const { ada, bo, key, adaSecrets, boSecrets } = await pair('admin');
    await ada.net.setRole(key, bo.net.snapshot().identity, 'admin');
    for (const admin of [ada, bo]) await admin.until(() => admin.net.confirmation(key).indexer);

    await ada.update(2, adaSecrets);
    await ada.net.setFormat(key, 2);
    await bo.until(() => Boolean(circleOf(bo, key)?.needsUpdate));
    const later = await ada.net.createInvite(key, Date.now() + 60 * 60_000);

    await bo.update(2, boSecrets);
    await bo.until(() => invites(bo, key).includes(later.id));
    const confirmed = (p: Person) => {
      const { length, signedLength } = p.net.confirmation(key);
      return length > 0 && signedLength >= length;
    };
    await ada.until(() => confirmed(ada));
    await bo.until(() => confirmed(bo));
    expect(invites(bo, key)).toEqual(invites(ada, key));
  });

  it('turns away a joiner on a build older than the Circle', async () => {
    const { ada, key, adaSecrets } = await pair('join');
    await ada.update(2, adaSecrets);
    await ada.net.setFormat(key, 2);
    const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    const cy = await person('join-cy', 1);
    await expect(cy.net.joinCircle(invite.code)).rejects.toThrow();
  });
});
