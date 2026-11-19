import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import Corestore from 'corestore';
import crypto from 'hypercore-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FolderMirror, type MirrorKnown } from '../folderMirror';
import { SharedFolders } from '../sharedFolders';

/**
 * Two Macs, each with a real folder on disk, kept in step through a shared folder on the pinned
 * Holepunch modules and the real macOS file watcher (ADR 0049 §8). Waits on the mirrors' status
 * reports and the folder views' changes, never on a timer.
 */

let dir: string;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'folder-mirror-net-'));
});

afterAll(async () => {
  for (const close of closers.reverse()) await close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

interface Mac {
  store: Corestore;
  folders: SharedFolders;
  root: string;
  mirror: FolderMirror | null;
  /** Resolves once `test` holds, checked after each view change and each mirror pass. */
  until(test: () => boolean | Promise<boolean>): Promise<void>;
  wake(): void;
}

function mac(name: string): Mac {
  const store = new Corestore(path.join(dir, `${name}-store`));
  const waiters = new Set<() => void>();
  const wake = () => waiters.forEach((w) => w());
  const m: Mac = {
    store,
    root: path.join(dir, `${name}-files`),
    mirror: null,
    folders: new SharedFolders({
      store,
      identity: crypto.keyPair(),
      device: crypto.keyPair(),
      name: () => name,
      ackInterval: 100,
      onChange: () => {
        void m.mirror?.viewChanged();
        wake();
      },
    }),
    wake,
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
  closers.push(
    async () => m.mirror?.stop(),
    () => m.folders.close(),
    () => store.close()
  );
  return m;
}

async function startMirror(m: Mac, key: string): Promise<void> {
  let known: MirrorKnown = {};
  m.mirror = new FolderMirror({
    root: m.root,
    folder: m.folders.forMirror(key),
    load: async () => known,
    save: async (next) => void (known = structuredClone(next)),
    quietMs: 200,
    onStatus: () => m.wake(),
  });
  await m.mirror.start();
}

const has = async (file: string, text: string) => {
  try {
    return (await readFile(file, 'utf8')) === text;
  } catch {
    return false;
  }
};
const gone = async (file: string) => stat(file).then(
  () => false,
  () => true
);

describe('two mirrors of one shared folder', () => {
  it('carries new files, edits and deletes between the Macs’ folders', async () => {
    const maya = mac('maya');
    const sam = mac('sam');
    const secrets = await maya.folders.create('Cover art', 'editor');
    await sam.folders.open({ ...secrets, namespace: 'sam' });
    const left = (maya.store as unknown as { replicate(i: boolean): Duplex }).replicate(true);
    const right = (sam.store as unknown as { replicate(i: boolean): Duplex }).replicate(false);
    left.pipe(right).pipe(left);
    closers.push(async () => {
      left.destroy();
      right.destroy();
    });
    await maya.folders.addWriter(secrets.key, sam.folders.intro(secrets.key));
    await sam.until(() => sam.folders.writable(secrets.key));

    await startMirror(maya, secrets.key);
    await startMirror(sam, secrets.key);

    // A file saved in Maya's folder appears in Sam's.
    await writeFile(path.join(maya.root, 'brief.md'), 'Option 2');
    await sam.until(() => has(path.join(sam.root, 'brief.md'), 'Option 2'));

    // Sam's edit, saved by writing a temporary file and renaming it over, comes back to Maya.
    await writeFile(path.join(sam.root, '.brief.md.sb-tmp'), 'Option 2, light weight');
    await rename(path.join(sam.root, '.brief.md.sb-tmp'), path.join(sam.root, 'brief.md'));
    await maya.until(() => has(path.join(maya.root, 'brief.md'), 'Option 2, light weight'));
    expect((await maya.folders.file(secrets.key, 'brief.md'))?.version).toBe(2);

    // Maya deletes it; it goes from Sam's folder too.
    await rm(path.join(maya.root, 'brief.md'));
    await sam.until(() => gone(path.join(sam.root, 'brief.md')));
    expect((await sam.folders.file(secrets.key, 'brief.md'))?.deleted).toBe(true);
  });
});
