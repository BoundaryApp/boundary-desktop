import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import Corestore from 'corestore';
import crypto from 'hypercore-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SharedFolders } from '../sharedFolders';

/**
 * A shared folder between three devices on the pinned Holepunch modules (ADR 0049 §2–§7): a manager
 * who creates it, an editor the manager adds, and a reader who only replicates. Peers replicate
 * over piped Corestore streams, the same `store.replicate` a Circle's connections use.
 */

let dir: string;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'shared-folders-'));
});

afterAll(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

interface Device {
  name: string;
  store: Corestore;
  folders: SharedFolders;
  /** Resolves once `test` holds, checked whenever a folder view changes. */
  until(test: () => boolean | Promise<boolean>): Promise<void>;
}

function device(name: string): Device {
  const store = new Corestore(path.join(dir, name));
  const waiters = new Set<() => void>();
  const folders = new SharedFolders({
    store,
    identity: crypto.keyPair(),
    device: crypto.keyPair(),
    name: () => name,
    ackInterval: 100,
    onChange: () => waiters.forEach((wake) => wake()),
  });
  closers.push(
    () => folders.close(),
    () => store.close()
  );
  return {
    name,
    store,
    folders,
    until: (test) =>
      new Promise<void>((resolve) => {
        const check = async () => {
          if (!(await test())) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        void check();
      }),
  };
}

function link(a: Device, b: Device): () => void {
  const left = (a.store as unknown as { replicate(initiator: boolean): Duplex }).replicate(true);
  const right = (b.store as unknown as { replicate(initiator: boolean): Duplex }).replicate(false);
  left.pipe(right).pipe(left);
  return () => {
    left.destroy();
    right.destroy();
  };
}

const live = async (d: Device, key: string) => (await d.folders.files(key)).filter((f) => !f.deleted).map((f) => f.path).sort();

describe('a shared folder between three devices', () => {
  it('shares, adds an editor, syncs contents, keeps crossed edits as copies, and removes', async () => {
    const maya = device('Maya');
    const sam = device('Sam');
    const priya = device('Priya');

    const secrets = await maya.folders.create('Cover art', 'editor');
    expect(await maya.folders.role(secrets.key)).toBe('manager');
    await maya.folders.put(secrets.key, 'brief.md', Buffer.from('Option 2, regular weight'), null, 1000);

    // Sam and Priya open it from the offer; until a manager adds Sam, both only replicate.
    await sam.folders.open({ ...secrets, namespace: 'sam-copy' });
    await priya.folders.open({ ...secrets, namespace: 'priya-copy' });
    const unlinkSam = link(maya, sam);
    const unlinkPriya = link(maya, priya);
    await sam.until(async () => (await live(sam, secrets.key)).includes('brief.md'));
    expect(sam.folders.writable(secrets.key)).toBe(false);
    await expect(sam.folders.put(secrets.key, 'x.md', Buffer.from('x'), null, 1)).rejects.toThrow();
    expect(String(await sam.folders.read(secrets.key, 'brief.md'))).toBe('Option 2, regular weight');

    await maya.folders.addWriter(secrets.key, sam.folders.intro(secrets.key));
    await sam.until(() => sam.folders.writable(secrets.key));
    expect(await sam.folders.role(secrets.key)).toBe('editor');

    // Sam's change reaches Priya through Maya, once Maya has fetched it.
    await sam.folders.put(secrets.key, 'brief.md', Buffer.from('Option 2, light weight'), 1, 1100);
    await priya.until(async () => (await priya.folders.file(secrets.key, 'brief.md'))?.version === 2);
    // Priya is connected only to Maya, who hasn't fetched Sam's contents: replication is sparse.
    expect(await priya.folders.read(secrets.key, 'brief.md', { wait: false })).toBeNull();
    await maya.until(async () => (await maya.folders.file(secrets.key, 'brief.md'))?.version === 2);
    expect(await maya.folders.downloadCurrent(secrets.key)).toBe(0);
    expect(String(await priya.folders.read(secrets.key, 'brief.md'))).toBe('Option 2, light weight');

    // Maya and Sam both edit version 2 while apart. After reconnecting, both views keep one in
    // place and the other as a conflict copy, the same on every device.
    unlinkSam();
    await maya.folders.put(secrets.key, 'brief.md', Buffer.from('Maya: three options'), 2, 1200);
    await sam.folders.put(secrets.key, 'brief.md', Buffer.from('Sam: two options'), 2, 1210);
    const unlinkSamAgain = link(maya, sam);
    const settled = async (d: Device) => (await live(d, secrets.key)).some((p) => p.includes('conflict'));
    await maya.until(() => settled(maya));
    await sam.until(() => settled(sam));
    await priya.until(() => settled(priya));
    await maya.folders.update(secrets.key);
    await sam.folders.update(secrets.key);
    const mayaFiles = await live(maya, secrets.key);
    expect(await live(sam, secrets.key)).toEqual(mayaFiles);
    expect(mayaFiles).toHaveLength(2);
    const copy = mayaFiles.find((p) => p.includes('conflict'))!;
    const kept = [String(await maya.folders.read(secrets.key, 'brief.md')), String(await maya.folders.read(secrets.key, copy))].sort();
    expect(kept).toEqual(['Maya: three options', 'Sam: two options']);

    // Removing Sam ends their writes.
    await maya.folders.removePerson(secrets.key, (await sam.folders.intro(secrets.key)).identity);
    await sam.until(() => !sam.folders.writable(secrets.key));
    expect(await sam.folders.role(secrets.key)).toBeNull();

    unlinkSamAgain();
    unlinkPriya();
  });

  it('keeps every version with its author, restores one, and settles conflicts with ordinary changes', async () => {
    const maya = device('Maya2');
    const sam = device('Sam2');
    const secrets = await maya.folders.create('Brief', 'editor');
    const key = secrets.key;
    await maya.folders.put(key, 'brief.md', Buffer.from('first'), null, 1000);
    await maya.folders.put(key, 'brief.md', Buffer.from('second'), 1, 1100);
    await maya.folders.put(key, 'notes.md', Buffer.from('n'), null, 1150);

    // Maya is the only manager, so her changes are confirmed once her device has signed them.
    await maya.until(async () => (await maya.folders.history(key)).every((change) => change.confirmed));
    const history = await maya.folders.history(key, { path: 'brief.md' });
    expect(history.map((change) => [change.version, change.at])).toEqual([[2, 1100], [1, 1000]]);
    expect((await maya.folders.history(key)).map((change) => change.path)).toEqual(['notes.md', 'brief.md', 'brief.md']);
    expect(await maya.folders.history(key, { path: '../x' })).toEqual([]);

    // Restoring version 1 writes it again as version 3.
    await maya.folders.restore(key, 'brief.md', history[1].seq, 1200);
    expect((await maya.folders.file(key, 'brief.md'))?.version).toBe(3);
    expect(String(await maya.folders.read(key, 'brief.md'))).toBe('first');
    expect(await maya.folders.hasVersion(key, history[0])).toBe(true);

    // Sam joins as an editor; both edit version 3 while apart.
    await sam.folders.open({ ...secrets, namespace: 'sam2-copy' });
    let unlink = link(maya, sam);
    await maya.folders.addWriter(key, sam.folders.intro(key));
    await sam.until(() => sam.folders.writable(key));
    await sam.until(async () => (await sam.folders.file(key, 'brief.md'))?.version === 3);
    unlink();
    await maya.folders.put(key, 'brief.md', Buffer.from('maya line\nshared'), 3, 1300);
    await sam.folders.put(key, 'brief.md', Buffer.from('sam line\nshared'), 3, 1310);
    unlink = link(maya, sam);
    const copyOf = async (d: Device) => (await d.folders.files(key)).find((f) => !f.deleted && f.conflictOf === 'brief.md') ?? null;
    await maya.until(async () => (await copyOf(maya)) !== null);
    await maya.folders.update(key);
    const copy = (await copyOf(maya))!;

    const compared = await maya.folders.compare(key, copy.path);
    expect(compared.original.path).toBe('brief.md');
    expect(compared.texts?.slice().sort()).toEqual(['maya line\nshared', 'sam line\nshared']);
    const copyText = String(await maya.folders.read(key, copy.path));

    // Keep the copy: it replaces the original, the copy goes, and the replaced version stays in history.
    await maya.folders.resolve(key, copy.path, 'copy', 1400);
    expect(String(await maya.folders.read(key, 'brief.md'))).toBe(copyText);
    expect((await maya.folders.file(key, copy.path))?.deleted).toBe(true);
    const texts = await Promise.all(
      (await maya.folders.history(key, { path: 'brief.md' })).map(async (v) => String(await maya.folders.readVersion(key, v)))
    );
    expect(texts).toContain(compared.texts!.find((t) => t !== copyText));
    await expect(maya.folders.resolve(key, copy.path, 'original', 1500)).rejects.toThrow('already settled');

    // Keep both: the copy is written again as an ordinary file.
    unlink();
    const now = (await maya.folders.file(key, 'brief.md'))!.version;
    await maya.folders.put(key, 'brief.md', Buffer.from('maya again'), now, 1600);
    await sam.until(async () => (await sam.folders.file(key, 'brief.md'))?.version === now);
    await sam.folders.put(key, 'brief.md', Buffer.from('sam again'), now, 1610);
    unlink = link(maya, sam);
    await maya.until(async () => (await copyOf(maya)) !== null);
    await maya.folders.update(key);
    const second = (await copyOf(maya))!;
    await maya.folders.resolve(key, second.path, 'both', 1700);
    const kept = await maya.folders.file(key, second.path);
    expect(kept?.deleted).toBe(false);
    expect(kept?.conflictOf).toBeUndefined();
    // Let both views finish applying before the stores close.
    await sam.until(async () => (await sam.folders.file(key, second.path))?.conflictOf === undefined);
    await maya.folders.update(key);
    await sam.folders.update(key);
    unlink();
  });
});
