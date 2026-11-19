import { watch, type FSWatcher } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import Autobase, { type AutobaseHost, type AutobaseNode } from 'autobase';
import Corestore, { type Hypercore } from 'corestore';
import Hyperblobs, { type BlobId } from 'hyperblobs';
import crypto from 'hypercore-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The module checks ADR 0049 lists before shared folders are built, run against the pinned
 * `hypercore`, `autobase` and `hyperblobs`. Findings are written up in docs/shared-folders-modules.md.
 * Peers replicate over piped Corestore streams instead of a testnet: these check the modules, not
 * the swarm.
 */

let dir: string;
const stores: Corestore[] = [];
const bases: Autobase[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'shared-folder-modules-'));
});

afterAll(async () => {
  for (const base of bases) await base.close().catch(() => {});
  for (const store of stores) await store.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

function store(name: string): Corestore {
  const s = new Corestore(path.join(dir, name));
  stores.push(s);
  return s;
}

/** Connects two stores as a swarm connection would; the returned function disconnects them. */
function link(a: Corestore, b: Corestore): () => void {
  const left = (a as unknown as { replicate(initiator: boolean): Duplex }).replicate(true);
  const right = (b as unknown as { replicate(initiator: boolean): Duplex }).replicate(false);
  left.pipe(right).pipe(left);
  return () => {
    left.destroy();
    right.destroy();
  };
}

describe('file contents in a blob core per device', () => {
  it('downloads only the blobs a peer asks for, and can drop them again', async () => {
    const a = store('blobs-a');
    const b = store('blobs-b');
    const key = crypto.randomBytes(32);
    const coreA = a.namespace('folder').get({ name: 'blobs', encryption: { key } });
    await coreA.ready();
    const blobsA = new Hyperblobs(coreA);
    const files = [0, 1, 2].map(() => crypto.randomBytes(200_000));
    const ids: BlobId[] = [];
    for (const file of files) ids.push(await blobsA.put(file));
    expect(ids[1].blockLength).toBeGreaterThan(1);

    const coreB = b.get({ key: coreA.key, encryption: { key } });
    await coreB.ready();
    const unlink = link(a, b);
    const blobsB = new Hyperblobs(coreB);
    const held = (id: BlobId) => coreB.has(id.blockOffset, id.blockOffset + id.blockLength);

    expect(await blobsB.get(ids[1])).toEqual(files[1]);
    expect(await held(ids[1])).toBe(true);
    expect(await held(ids[0])).toBe(false);
    expect(await held(ids[2])).toBe(false);

    await coreB.clear(ids[1].blockOffset, ids[1].blockOffset + ids[1].blockLength);
    expect(await held(ids[1])).toBe(false);
    expect(await blobsB.get(ids[1])).toEqual(files[1]);

    unlink();
    // With the writer gone, a version nobody else holds can't be read; wait: false says so at once.
    expect(await blobsB.get(ids[0], { wait: false })).toBeNull();
  });

  it('gives a device without the folder key only ciphertext', async () => {
    const a = store('cipher-a');
    const c = store('cipher-c');
    const key = crypto.randomBytes(32);
    const coreA = a.get({ name: 'blobs', encryption: { key } });
    await coreA.ready();
    const file = Buffer.from('Spring list cover brief');
    const id = await new Hyperblobs(coreA).put(file);
    const coreC = c.get({ key: coreA.key });
    await coreC.ready();
    const unlink = link(a, c);
    const read = await new Hyperblobs(coreC).get(id);
    unlink();
    expect(read?.includes(file)).toBe(false);
  });
});

interface FolderOp {
  op: 'add-writer' | 'remove-writer' | 'put';
  key?: string;
  indexer?: boolean;
  path?: string;
}

/** A folder Autobase reduced to what the writer checks need: writer changes and puts. */
function folderBase(s: Corestore, bootstrap: Buffer | null, encryptionKey?: Buffer): Autobase {
  const base = new Autobase(s, bootstrap, {
    valueEncoding: 'json',
    encrypt: true,
    encryptionKey,
    ackInterval: 100,
    open: (viewStore) => viewStore.get({ name: 'view' }),
    apply: async (nodes: AutobaseNode[], view: Hypercore, host: AutobaseHost) => {
      for (const node of nodes) {
        const op = node.value as FolderOp;
        if (op.op === 'add-writer') await host.addWriter(Buffer.from(op.key!, 'hex'), { indexer: !!op.indexer });
        else if (op.op === 'remove-writer') {
          const k = Buffer.from(op.key!, 'hex');
          if (host.removeable(k)) await host.removeWriter(k);
        } else await view.append(JSON.stringify({ path: op.path, from: node.from.key.toString('hex') }));
      }
    },
  });
  bases.push(base);
  return base;
}

async function paths(base: Autobase): Promise<string[]> {
  const view = base.view as Hypercore;
  const out: string[] = [];
  for (let i = 0; i < view.length; i++) out.push(JSON.parse(String(await view.get(i))).path);
  return out;
}

/** Resolves once `test` holds, checked after every update of `base`. */
function until(base: Autobase, test: () => boolean | Promise<boolean>): Promise<void> {
  return new Promise((resolve) => {
    const check = async () => {
      if (!(await test())) return;
      base.off('update', check);
      resolve();
    };
    base.on('update', check);
    void check();
  });
}

describe('writers added and removed from apply', () => {
  it('adds an editor, keeps the last indexer, and orders a write made offline after removal', async () => {
    const sa = store('writers-a');
    const sb = store('writers-b');
    const manager = folderBase(sa, null);
    await manager.ready();
    const editor = folderBase(sb, manager.key, manager.encryptionKey!);
    await editor.ready();
    let unlink = link(sa, sb);

    await manager.append({ op: 'add-writer', key: editor.local!.key.toString('hex'), indexer: false });
    await until(editor, () => editor.writable);
    expect(editor.isIndexer).toBe(false);

    await editor.append({ op: 'put', path: 'brief.md' });
    await until(manager, async () => (await paths(manager)).includes('brief.md'));

    // The only indexer can't be removed: apply's removeable check skips it.
    await manager.append({ op: 'remove-writer', key: manager.local!.key.toString('hex') });
    await manager.update();
    expect(manager.writable).toBe(true);
    expect(manager.isIndexer).toBe(true);

    // The editor goes offline. The manager removes them; the editor, not knowing, writes again.
    unlink();
    await manager.append({ op: 'remove-writer', key: editor.local!.key.toString('hex') });
    await manager.append({ op: 'put', path: 'after-removal-by-manager.md' });
    expect(editor.writable).toBe(true);
    await editor.append({ op: 'put', path: 'written-offline.md' });

    unlink = link(sa, sb);
    await until(editor, () => !editor.writable);
    await until(manager, async () => (await paths(manager)).includes('after-removal-by-manager.md'));
    await manager.update();
    await editor.update();
    const seenByManager = await paths(manager);
    const seenByEditor = await paths(editor);
    unlink();

    // Recorded in docs/shared-folders-modules.md: whether an entry the removed writer made
    // without seeing its removal is applied.
    expect(seenByEditor).toEqual(seenByManager);
    expect(seenByManager).toContain('brief.md');
    expect(seenByManager).not.toContain('written-offline.md');
  });
});

describe.runIf(process.platform === 'darwin')('the macOS file watcher', () => {
  it('reports writes, saves by rename, renames, folders and deletes by path', async () => {
    const root = path.join(dir, 'watched');
    await mkdir(root);
    const events: Array<[string, string]> = [];
    const waiters = new Set<() => void>();
    const watcher: FSWatcher = watch(root, { recursive: true }, (type, name) => {
      events.push([type, String(name)]);
      waiters.forEach((wake) => wake());
    });
    /** Resolves once an event for `name` arrives after the first `from` events. */
    const after = (from: number, name: string) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!events.slice(from).some(([, n]) => n === name)) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      });
    const seen = (name: string) => after(0, name);

    await writeFile(path.join(root, 'notes.md'), 'one');
    await seen('notes.md');

    // An editor's save: write a temporary file, then rename it over the original.
    const before = events.length;
    await writeFile(path.join(root, '.notes.md.sb-tmp'), 'two');
    await rename(path.join(root, '.notes.md.sb-tmp'), path.join(root, 'notes.md'));
    await seen('.notes.md.sb-tmp');
    await after(before, 'notes.md');

    // A change in place, as a program that rewrites the file without a temporary file.
    const inPlace = events.length;
    await writeFile(path.join(root, 'notes.md'), 'three');
    await after(inPlace, 'notes.md');

    await rename(path.join(root, 'notes.md'), path.join(root, 'brief.md'));
    await seen('brief.md');

    await mkdir(path.join(root, 'covers'));
    await writeFile(path.join(root, 'covers', 'option-1.png'), Buffer.alloc(1024));
    await seen('covers/option-1.png');

    const removed = events.length;
    await rm(path.join(root, 'brief.md'));
    await after(removed, 'brief.md');
    watcher.close();

    // Paths are relative to the root and use '/'. The type is 'rename' for creates, deletes,
    // renames and saves alike, so it can't say whether the path still exists: a mirror stats and
    // hashes every path it is told about.
    expect(events.every(([type]) => type === 'rename' || type === 'change')).toBe(true);
    expect(events.filter(([, name]) => name === 'brief.md').every(([type]) => type === 'rename')).toBe(true);
  });
});
