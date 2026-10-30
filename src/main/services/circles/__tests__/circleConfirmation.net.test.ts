import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircleNetwork } from '../circleNetwork';
import type { CircleSecrets } from '../networkMessages';

/**
 * The live check that docs/circles-autobase-confirmation.md asks for: a Circle with three admins,
 * all offline but one. An entry written then reaches members at once but is not ordered for good
 * until a majority of admins (two of three) has acked it. Waits on the runtime's change events.
 *
 * Admins ack every 500 ms here instead of 10 s. At 10 s, over three runs, a promoted admin took
 * 31–41 s to become an active indexer and the last step took 29–54 s: Autobase pushes the ack
 * timer back on every update (`lib/timer.js`, `bump`).
 */

interface Person {
  name: string;
  net: CircleNetwork;
  /** Resolves once `test` holds, checked on every change. */
  until(test: () => boolean): Promise<void>;
  /** Close the network, as when Boundary quits. */
  stop(): Promise<void>;
  /** Start again from the same storage and seeds, and reopen `secrets`. */
  restart(secrets: CircleSecrets): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const nets: CircleNetwork[] = [];

async function person(name: string): Promise<Person> {
  const seeds = { identitySeed: crypto.randomBytes(32), deviceSeed: crypto.randomBytes(32) };
  const waiters = new Set<() => void>();
  const start = async () => {
    const net = new CircleNetwork({
      storageDir: path.join(dir, name),
      ...seeds,
      name,
      ackInterval: 500,
      bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
      onChange: () => waiters.forEach((wake) => wake()),
    });
    await net.ready();
    nets.push(net);
    return net;
  };
  const made: Person = {
    name,
    net: await start(),
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
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-confirm-'));
});

afterAll(async () => {
  for (const net of nets) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('confirmation with three admins', () => {
  let ada: Person;
  let bo: Person;
  let cy: Person;
  let dee: Person;
  let key: string;
  const secrets = new Map<string, CircleSecrets>();

  const confirmed = (p: Person) => {
    const { length, signedLength } = p.net.confirmation(key);
    return signedLength >= length;
  };
  const memberOnline = (p: Person, name: string) =>
    Boolean(
      p.net
        .snapshot()
        .circles.find((circle) => circle.key === key)
        ?.members.find((member) => member.name === name)?.online
    );
  const inviteCount = (p: Person) =>
    p.net.snapshot().circles.find((circle) => circle.key === key)?.invites.length ?? 0;

  it('sets up a Circle with three admins and one member, all confirmed', async () => {
    ada = await person('Ada');
    const created = await ada.net.createCircle('Allotment');
    key = created.key!;
    for (const name of ['Bo', 'Cy', 'Dee']) {
      const p = await person(name);
      const invite = await ada.net.createInvite(key, Date.now() + 60 * 60_000);
      secrets.set(name, await p.net.joinCircle(invite.code));
      if (name === 'Bo') bo = p;
      else if (name === 'Cy') cy = p;
      else dee = p;
    }
    await ada.net.setRole(key, bo.net.snapshot().identity, 'admin');
    await ada.net.setRole(key, cy.net.snapshot().identity, 'admin');

    // Promotion lists Bo and Cy as indexers at once, but each device only becomes an active
    // indexer after it acks. Stopping them before that leaves Ada as the only active one.
    for (const admin of [ada, bo, cy]) await admin.until(() => admin.net.confirmation(key).indexer);
    await ada.until(() => ada.net.confirmation(key).indexers === 3 && confirmed(ada));
    await dee.until(() => confirmed(dee));
  });

  it('shows an entry to members while one of three admins is online, unconfirmed', async () => {
    await bo.stop();
    await cy.stop();
    await ada.until(() => !memberOnline(ada, 'Bo') && !memberOnline(ada, 'Cy'));

    const before = inviteCount(dee);
    await ada.net.createInvite(key, Date.now() + 60 * 60_000);
    await dee.until(() => inviteCount(dee) === before + 1);

    // Dee has the entry in her view, and neither side has it signed: one indexer of three is
    // not a majority, however long Ada waits.
    expect(confirmed(dee)).toBe(false);
    expect(confirmed(ada)).toBe(false);
    expect(ada.net.confirmation(key).indexers).toBe(3);
  });

  it('confirms the entry once a second admin comes back', async () => {
    await bo.restart(secrets.get('Bo')!);
    await ada.until(() => confirmed(ada));
    await dee.until(() => confirmed(dee));
    // Bo restarted from disk and still has the Circle, invite included.
    await bo.until(() => inviteCount(bo) === inviteCount(ada));
  });
});
