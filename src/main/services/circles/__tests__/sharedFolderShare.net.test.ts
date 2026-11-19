import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircleNetwork } from '../circleNetwork';
import type { LocalSharedFolder } from '../circlesStore';
import { FolderRuntime, handleFolderRequest } from '../folderRuntime';
import { scanFolder } from '../folderScan';
import { FOLDER_JOINS_APP, SharedFolderManager } from '../sharedFolderManager';

/**
 * Sharing a folder end to end (ADR 0049 §3, §5, §8, §12), with main's manager wired straight to a
 * real CircleNetwork on a HyperDHT testnet instead of through the network process: Ada shares a
 * folder that already holds a file, Bo adds it from the offer, Ada's device adds Bo as a writer on
 * its own, their folders on disk stay in step, and removing Bo from the Circle takes him out.
 * Waits on change events, never on a timer.
 */

interface Person {
  net: CircleNetwork;
  runtime: FolderRuntime;
  manager: SharedFolderManager;
  identity: string;
  home: string;
  until(test: () => boolean | Promise<boolean>): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const people: Person[] = [];

async function person(name: string): Promise<Person> {
  const waiters = new Set<() => void>();
  const wake = () => waiters.forEach((check) => check());
  const home = path.join(dir, `${name}-home`);
  await mkdir(home, { recursive: true });
  const local: LocalSharedFolder[] = [];
  let manager: SharedFolderManager | null = null;
  let runtime: FolderRuntime | null = null;
  const net = new CircleNetwork({
    storageDir: path.join(dir, `${name}-net`),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    ackInterval: 300,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: () => {
      for (const key of manager?.localKeys() ?? []) void manager?.reconcile(key);
      wake();
    },
    onRecord: (change) => {
      if (change.app === FOLDER_JOINS_APP) manager?.onJoinRecord(change);
      wake();
    },
    onRemoved: (key) => {
      void manager?.onCircleRemoved(key).then(wake);
    },
    onFolderChange: (key) => {
      runtime?.viewChanged(key);
      void manager?.reconcile(key).then(wake);
      wake();
    },
  });
  await net.ready();
  net.setRecordApps([FOLDER_JOINS_APP]);
  runtime = new FolderRuntime({
    folders: net.folders,
    stateDir: path.join(dir, `${name}-mirrors`),
    onStatus: wake,
    mirrorTiming: { quietMs: 200 },
  });
  const rt = runtime;
  manager = new SharedFolderManager({
    request: (body) => handleFolderRequest(net.folders, rt, body),
    circles: () => net.snapshot().circles,
    identity: () => net.snapshot().identity,
    setRecord: (circle, app, record, value, keep) => net.setRecord(circle, app, 'member', record, value, { keep }),
    deleteRecord: (circle, app, record) => net.deleteRecord(circle, app, 'member', record),
    listRecords: (circle, app) => net.listRecords(circle, app),
    load: async () => local,
    save: async (folder) => void local.push(folder),
    forget: () => {},
    refuse: () => null,
    isGitRepo: () => false,
    isDirectory: (p) => p.startsWith(dir),
    copy: async () => {},
    moveToTrash: (p) => rm(p, { recursive: true, force: true }),
    scan: scanFolder,
    home,
    log: () => {},
  });
  const made: Person = {
    net,
    runtime,
    manager,
    identity: net.snapshot().identity,
    home,
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
  people.push(made);
  return made;
}

const has = async (file: string, text: string) => {
  try {
    return (await readFile(file, 'utf8')) === text;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-folder-share-'));
});

afterAll(async () => {
  for (const p of people) {
    await p.runtime.close();
    await p.net.close();
  }
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('sharing a folder with a Circle', () => {
  it('offers, adds, syncs both ways, and removes a member who leaves the Circle', async () => {
    const ada = await person('ada');
    const bo = await person('bo');
    const circle = (await ada.net.createCircle('Studio')).key!;
    const invite = await ada.net.createInvite(circle, Date.now() + 60 * 60_000);
    await bo.net.joinCircle(invite.code);
    await ada.until(() => (ada.net.snapshot().circles[0]?.members.length ?? 0) === 2);

    // Ada shares a folder that already holds a file.
    const source = path.join(ada.home, 'spring-list');
    await mkdir(source);
    await writeFile(path.join(source, 'brief.md'), 'Option 2');
    const shared = await ada.manager.share(circle, { name: 'spring-list', source, role: 'editor' });

    // Bo sees the offer and adds it.
    await bo.until(async () => (await bo.manager.list(circle)).length === 1);
    const [offer] = await bo.manager.list(circle);
    expect(offer).toMatchObject({ key: shared.key, name: 'spring-list', by: ada.identity, local: null });
    const boRoot = bo.manager.defaultRoot('Studio', offer.name);
    await bo.manager.add(circle, shared.key, boRoot);

    // Ada's device adds him as a writer on its own; the file reaches his folder.
    await bo.until(() => bo.net.folders.writable(shared.key));
    await bo.until(() => has(path.join(boRoot, 'brief.md'), 'Option 2'));

    // A file Bo saves reaches Ada's folder.
    await writeFile(path.join(boRoot, 'notes.md'), 'From Bo');
    await ada.until(() => has(path.join(source, 'notes.md'), 'From Bo'));

    // Removing Bo from the Circle takes him out of the folder. His Mac is cut off, so it never
    // sees that; the Circle's removal notice stops his copy syncing, and the files stay (§12).
    await ada.net.removeMember(circle, bo.identity);
    await ada.until(async () => !(await ada.net.folders.people(shared.key)).some((p) => p.identity === bo.identity));
    await bo.until(() => bo.manager.localKeys().length === 0);
    expect(bo.net.folders.isOpen(shared.key)).toBe(false);
    expect((await stat(path.join(boRoot, 'brief.md'))).isFile()).toBe(true);
  });
});
