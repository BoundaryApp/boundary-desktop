import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { SharedFolderSummary } from '../../../../shared/types/sharedFolders';
import type { LocalSharedFolder } from '../circlesStore';
import type { FolderDeviceIntro } from '../folderOps';
import type { CircleRecordChange, FolderReply, FolderRequest } from '../networkMessages';
import { FOLDER_JOINS_APP, FOLDER_OFFERS_APP, SharedFolderManager, type SharedFolderDeps } from '../sharedFolderManager';

const hex = (char: string, length = 64) => char.repeat(length);
const HOME = '/Users/jordan';
const ME = hex('1');
const SAM = hex('2');
const PRIYA = hex('3');
const STUDIO = hex('5');
const FOLDER = hex('a');

const intro = (identity: string, writer: string): FolderDeviceIntro => ({
  identity,
  name: 'Sam',
  device: identity,
  writer,
  blobs: hex('9'),
  signature: hex('8', 128),
});

function summary(over: Partial<SharedFolderSummary> = {}): SharedFolderSummary {
  return {
    defaultRole: 'editor',
    people: [{ identity: ME, name: 'Jordan', role: 'manager' }],
    writers: [{ identity: ME, writer: hex('b') }],
    role: 'manager',
    writable: true,
    files: 0,
    bytes: 0,
    mirror: null,
    conflicts: [],
    unconfirmed: 0,
    ...over,
  };
}

function setup(opts: { members?: string[]; summary?: SharedFolderSummary; git?: string[]; refused?: string[]; dirs?: string[] } = {}) {
  const requests: FolderRequest[] = [];
  const records = new Map<string, { identity: string | null; key: string; value: unknown }[]>();
  const saved: LocalSharedFolder[] = [];
  const forgotten: string[] = [];
  const trashed: string[] = [];
  const copied: Array<[string, string]> = [];
  const deleted: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const circles: CircleSnapshot[] = [
    {
      key: STUDIO,
      name: 'Studio',
      members: (opts.members ?? [ME, SAM, PRIYA]).map((identity) => ({ identity, name: identity.slice(0, 1) })),
    } as unknown as CircleSnapshot,
  ];
  const deps: SharedFolderDeps = {
    request: async (body): Promise<FolderReply> => {
      requests.push(body);
      if (body.op === 'folder-create') return { folder: { key: FOLDER, encryptionKey: hex('e'), namespace: 'ns' } };
      if (body.op === 'folder-intro') return { intro: intro(ME, hex('c')) };
      if (body.op === 'folder-summary') return { summary: opts.summary ?? summary() };
      return {};
    },
    circles: () => circles,
    identity: () => ME,
    setRecord: async (circle, app, record, value, keep) => {
      const list = records.get(`${circle}/${app}`) ?? [];
      records.set(`${circle}/${app}`, [...list.filter((r) => r.key !== record), { identity: ME, key: record, value: keep ? { kept: true, ...(value as object) } : value }]);
    },
    deleteRecord: async (circle, app, record) => void deleted.push([circle, app, record]),
    listRecords: async (circle, app) => records.get(`${circle}/${app}`) ?? [],
    load: async () => saved,
    save: async (folder) => void saved.push(folder),
    forget: (key) => void forgotten.push(key),
    refuse: (p) => ((opts.refused ?? []).includes(p) ? 'System and Library folders can’t be shared.' : null),
    isGitRepo: (p) => (opts.git ?? []).includes(p),
    isDirectory: (p) => (opts.dirs ?? ['/Users/jordan/Projects/spring-list']).includes(p),
    copy: async (from, to) => void copied.push([from, to]),
    moveToTrash: async (p) => void trashed.push(p),
    scan: async () => ({ files: 12, bytes: 3400, unshared: [], unsharedCount: 0, partial: false }),
    home: HOME,
    log: (message) => void logs.push(message),
    now: () => Date.UTC(2026, 10, 9),
  };
  const manager = new SharedFolderManager(deps);
  const offer = (value: unknown, identity: string | null = SAM, key = FOLDER) =>
    records.set(`${STUDIO}/${FOLDER_OFFERS_APP}`, [{ identity, key, value }]);
  return { manager, requests, records, saved, forgotten, trashed, copied, deleted, logs, offer, circles };
}

const goodOffer = { name: 'Cover art', key: FOLDER, encryptionKey: hex('e') };
const join = (identity: string, value: unknown, deleted = false): CircleRecordChange =>
  ({ circleKey: STUDIO, app: FOLDER_JOINS_APP, scope: 'member', identity, key: FOLDER, value, confirmed: true, deleted }) as CircleRecordChange;
const ops = (requests: FolderRequest[]) => requests.map((r) => r.op);

describe('checking a folder before sharing', () => {
  it('offers a copy for a folder in a sync tool, before any other check', () => {
    const { manager } = setup({ refused: [`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Manuscripts`] });
    expect(manager.checkFolder(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Manuscripts`)).toMatchObject({ kind: 'sync-tool', tool: 'iCloud Drive' });
    expect(manager.checkFolder(`${HOME}/Library/CloudStorage/GoogleDrive-me@example.com/x`)).toMatchObject({ tool: 'Google Drive' });
    expect(manager.checkFolder(`${HOME}/Dropbox/notes`)).toMatchObject({ tool: 'Dropbox' });
  });

  it('refuses what the coding-folder rules refuse, and git repositories', () => {
    const { manager } = setup({ refused: ['/Applications'], git: [`${HOME}/Code/press-site`] });
    expect(manager.checkFolder('/Applications')).toMatchObject({ kind: 'refused' });
    expect(manager.checkFolder(`${HOME}/Code/press-site`)).toMatchObject({ kind: 'git' });
    expect(manager.checkFolder(`${HOME}/Projects/spring-list`)).toBeNull();
  });
});

describe('sharing', () => {
  it('shares a folder where it is, mirrors it and offers it as a kept record', async () => {
    const t = setup();
    const done = await t.manager.share(STUDIO, { name: 'spring-list', source: `${HOME}/Projects/spring-list`, role: 'editor' });
    expect(done).toEqual({ key: FOLDER, root: `${HOME}/Projects/spring-list` });
    expect(t.requests).toEqual([
      { op: 'folder-create', name: 'spring-list', role: 'editor' },
      { op: 'folder-mirror', key: FOLDER, root: `${HOME}/Projects/spring-list` },
    ]);
    expect(t.saved[0]).toMatchObject({ circle: STUDIO, name: 'spring-list', root: `${HOME}/Projects/spring-list` });
    expect(t.records.get(`${STUDIO}/${FOLDER_OFFERS_APP}`)).toEqual([{ identity: ME, key: FOLDER, value: { kept: true, ...goodOffer, name: 'spring-list', role: 'editor', files: 12, bytes: 3400 } }]);
  });

  it('makes the chosen members managers, skipping this user and people outside the Circle', async () => {
    const t = setup();
    await t.manager.share(STUDIO, {
      name: 'spring-list',
      source: `${HOME}/Projects/spring-list`,
      role: 'editor',
      managers: [
        { identity: SAM, name: 'Sam' },
        { identity: ME, name: 'Jordan' },
        { identity: hex('7'), name: 'Stranger' },
      ],
    });
    expect(t.requests.filter((r) => r.op === 'folder-set-role')).toEqual([
      { op: 'folder-set-role', key: FOLDER, identity: SAM, role: 'manager', name: 'Sam' },
    ]);
    await expect(t.manager.history(hex('6'))).rejects.toThrow('isn’t on this Mac');
  });

  it('starts an empty folder in ~/Circles/<Circle>/, with names made safe as folder names', async () => {
    const t = setup();
    const done = await t.manager.share(STUDIO, { name: 'Spring / Summer: list', source: null, role: 'reader' });
    expect(done.root).toBe(path.join(HOME, 'Circles', 'Studio', 'Spring   Summer  list'));
    expect(t.records.get(`${STUDIO}/${FOLDER_OFFERS_APP}`)?.[0].value).toMatchObject({ role: 'reader', files: 0, bytes: 0 });
  });

  it('refuses a missing folder, a git repository, and a sync-tool folder unless it shares a copy', async () => {
    const icloud = `${HOME}/Library/Mobile Documents/com~apple~CloudDocs/Manuscripts`;
    const t = setup({ git: [`${HOME}/Code/press-site`], dirs: [`${HOME}/Code/press-site`, icloud] });
    await expect(t.manager.share(STUDIO, { name: 'x', source: `${HOME}/nowhere`, role: 'editor' })).rejects.toThrow('doesn’t exist');
    await expect(t.manager.share(STUDIO, { name: 'x', source: `${HOME}/Code/press-site`, role: 'editor' })).rejects.toThrow('git repository');
    await expect(t.manager.share(STUDIO, { name: 'Manuscripts', source: icloud, role: 'editor' })).rejects.toThrow('iCloud Drive');
    const done = await t.manager.share(STUDIO, { name: 'Manuscripts', source: icloud, copy: true, role: 'editor' });
    expect(t.copied).toEqual([[icloud, path.join(HOME, 'Circles', 'Studio', 'Manuscripts')]]);
    expect(done.root).toBe(path.join(HOME, 'Circles', 'Studio', 'Manuscripts'));
  });
});

describe('adding an offered folder', () => {
  it('opens it, mirrors it where asked, and asks its managers to let this device write', async () => {
    const t = setup();
    t.offer(goodOffer);
    await t.manager.add(STUDIO, FOLDER, `${HOME}/Circles/Studio/Cover art`);
    expect(ops(t.requests)).toEqual(['folder-open', 'folder-mirror', 'folder-intro']);
    expect(t.requests[0]).toMatchObject({ folder: { key: FOLDER, encryptionKey: hex('e') } });
    expect(t.records.get(`${STUDIO}/${FOLDER_JOINS_APP}`)).toEqual([{ identity: ME, key: FOLDER, value: intro(ME, hex('c')) }]);
    await expect(t.manager.add(STUDIO, FOLDER, '/tmp/again')).rejects.toThrow('already on this Mac');
  });

  it('refuses an offer that is malformed or names another folder', async () => {
    for (const value of [{ ...goodOffer, key: hex('f') }, { ...goodOffer, encryptionKey: 'short' }, { ...goodOffer, name: '' }, 'nope']) {
      const t = setup();
      t.offer(value);
      await expect(t.manager.add(STUDIO, FOLDER, '/tmp/x')).rejects.toThrow('isn’t shared');
    }
  });

  it('lists offers with what this Mac has, skipping bad ones', async () => {
    const t = setup();
    t.offer(goodOffer);
    expect(await t.manager.list(STUDIO)).toEqual([{ circle: STUDIO, key: FOLDER, name: 'Cover art', by: SAM, offered: null, local: null }]);
    expect(t.manager.rootOf(FOLDER)).toBeNull();
    await t.manager.add(STUDIO, FOLDER, '/tmp/cover');
    const [listed] = await t.manager.list(STUDIO);
    expect(listed.local).toEqual({ root: '/tmp/cover', summary: summary() });
    expect(t.manager.rootOf(FOLDER)).toBe('/tmp/cover');
    t.offer(goodOffer, null);
    expect(await t.manager.list(STUDIO)).toEqual([]);
  });

  it('shows the facts an offer carries only when they all make sense', async () => {
    const t = setup();
    t.offer({ ...goodOffer, role: 'reader', files: 3, bytes: 900 });
    expect((await t.manager.list(STUDIO))[0].offered).toEqual({ role: 'reader', files: 3, bytes: 900 });
    for (const bad of [{ role: 'manager', files: 3, bytes: 9 }, { role: 'editor', files: -1, bytes: 9 }, { role: 'editor', files: 3 }, { role: 'editor', files: 1.5, bytes: 9 }]) {
      t.offer({ ...goodOffer, ...bad });
      expect((await t.manager.list(STUDIO))[0].offered).toBeNull();
    }
  });
});

describe('leaving the Circle', () => {
  it('stops syncing, keeps the files and remembers the folder as no longer shared', async () => {
    const t = setup();
    t.offer(goodOffer);
    await t.manager.add(STUDIO, FOLDER, '/tmp/cover');
    t.requests.length = 0;
    await t.manager.onCircleRemoved(STUDIO);
    expect(ops(t.requests)).toEqual(['folder-unmirror', 'folder-close']);
    expect(t.trashed).toEqual([]);
    expect(t.forgotten).toEqual([]);
    expect(t.saved.at(-1)).toMatchObject({ circleName: 'Studio', root: '/tmp/cover', ended: Date.UTC(2026, 10, 9) });
    expect(t.manager.localKeys()).toEqual([]);
    expect(await t.manager.onMac()).toEqual([
      expect.objectContaining({ key: FOLDER, circleName: 'Studio', name: 'Cover art', root: '/tmp/cover', role: null, ended: Date.UTC(2026, 10, 9) }),
    ]);
  });

  it('doesn’t reopen an ended folder at start, and removing it forgets the record', async () => {
    const t = setup();
    t.saved.push({ circle: STUDIO, circleName: 'Studio', name: 'A', secrets: { key: hex('a'), encryptionKey: hex('e'), namespace: 'a' }, root: '/tmp/a', ended: 5 });
    await t.manager.start();
    expect(t.requests).toEqual([]);
    expect((await t.manager.onMac()).map((f) => f.ended)).toEqual([5]);
    await t.manager.remove(hex('a'), { trash: false });
    expect(t.forgotten).toEqual([hex('a')]);
    expect(t.trashed).toEqual([]);
    expect(await t.manager.onMac()).toEqual([]);
  });
});

describe('folders on this Mac', () => {
  it('lists each with its Circle, role, people and managers by name', async () => {
    const t = setup({
      summary: summary({
        role: 'editor',
        people: [
          { identity: SAM, name: 'Sam', role: 'manager' },
          { identity: ME, name: 'Jordan', role: 'editor' },
        ],
      }),
    });
    t.offer(goodOffer);
    await t.manager.add(STUDIO, FOLDER, '/tmp/cover');
    expect(await t.manager.onMac()).toEqual([
      {
        key: FOLDER,
        circle: STUDIO,
        circleName: 'Studio',
        name: 'Cover art',
        root: '/tmp/cover',
        role: 'editor',
        defaultRole: 'editor',
        people: 2,
        managers: [SAM.slice(0, 1)],
        ended: null,
      },
    ]);
  });
});

describe('removing from this Mac', () => {
  it('stops syncing, forgets it, withdraws the join request, and keeps the files unless asked', async () => {
    const t = setup();
    t.offer(goodOffer);
    await t.manager.add(STUDIO, FOLDER, '/tmp/cover');
    t.requests.length = 0;
    await t.manager.remove(FOLDER, { trash: false });
    expect(t.requests).toEqual([{ op: 'folder-unmirror', key: FOLDER, forget: true }, { op: 'folder-close', key: FOLDER }]);
    expect(t.forgotten).toEqual([FOLDER]);
    expect(t.deleted).toEqual([[STUDIO, FOLDER_JOINS_APP, FOLDER]]);
    expect(t.trashed).toEqual([]);
    expect(t.manager.localKeys()).toEqual([]);
  });

  it('moves the files to the Trash when asked', async () => {
    const t = setup();
    t.offer(goodOffer);
    await t.manager.add(STUDIO, FOLDER, '/tmp/cover');
    await t.manager.remove(FOLDER, { trash: true });
    expect(t.trashed).toEqual(['/tmp/cover']);
  });
});

describe('as a manager', () => {
  async function managing(opts: Parameters<typeof setup>[0] = {}) {
    const t = setup(opts);
    await t.manager.share(STUDIO, { name: 'Cover art', source: null, role: 'editor' });
    t.requests.length = 0;
    return t;
  }
  const adds = (requests: FolderRequest[]) => requests.filter((r) => r.op === 'folder-add-writer');

  it('adds a member who asked to join at the default role', async () => {
    const t = await managing();
    t.manager.onJoinRecord(join(SAM, intro(SAM, hex('d'))));
    await t.manager.reconcile(FOLDER);
    expect(adds(t.requests)).toEqual([{ op: 'folder-add-writer', key: FOLDER, intro: intro(SAM, hex('d')) }]);
  });

  it('leaves out readers, writers already added, requests made for someone else, and non-members', async () => {
    const t = await managing({
      members: [ME, SAM],
      summary: summary({
        people: [
          { identity: ME, name: 'Jordan', role: 'manager' },
          { identity: SAM, name: 'Sam', role: 'reader' },
        ],
      }),
    });
    t.manager.onJoinRecord(join(SAM, intro(SAM, hex('d'))));
    t.manager.onJoinRecord(join(PRIYA, intro(SAM, hex('7'))));
    t.manager.onJoinRecord(join(hex('4'), intro(hex('4'), hex('6'))));
    await t.manager.reconcile(FOLDER);
    expect(adds(t.requests)).toEqual([]);
  });

  it('removes people who are no longer in the Circle', async () => {
    const t = await managing({
      members: [ME, SAM],
      summary: summary({ people: [{ identity: ME, name: 'Jordan', role: 'manager' }, { identity: PRIYA, name: 'Priya', role: 'editor' }] }),
    });
    await t.manager.reconcile(FOLDER);
    expect(t.requests.filter((r) => r.op === 'folder-remove-person')).toEqual([{ op: 'folder-remove-person', key: FOLDER, identity: PRIYA }]);
  });

  it('does nothing in a folder this device doesn’t manage', async () => {
    const t = await managing({ summary: summary({ role: 'editor' }) });
    t.manager.onJoinRecord(join(SAM, intro(SAM, hex('d'))));
    await t.manager.reconcile(FOLDER);
    expect(ops(t.requests)).toEqual(['folder-summary']);
  });
});

describe('starting', () => {
  it('reopens and mirrors every folder on this Mac, and one that fails doesn’t stop the rest', async () => {
    const t = setup();
    t.saved.push(
      { circle: STUDIO, name: 'A', secrets: { key: hex('a'), encryptionKey: hex('e'), namespace: 'a' }, root: '/tmp/a' },
      { circle: STUDIO, name: 'B', secrets: { key: hex('b'), encryptionKey: hex('e'), namespace: 'b' }, root: '/tmp/b' }
    );
    const failing = new SharedFolderManager({
      ...((t.manager as unknown as { deps: SharedFolderDeps }).deps),
      request: async (body) => {
        t.requests.push(body);
        if (body.op === 'folder-open' && body.folder.key === hex('a')) throw new Error('boom');
        return {};
      },
    });
    await failing.start();
    expect(t.requests.map((r) => `${r.op}:${'key' in r ? r.key.slice(0, 1) : r.op === 'folder-open' ? r.folder.key.slice(0, 1) : ''}`)).toEqual([
      'folder-open:a',
      'folder-open:b',
      'folder-mirror:b',
    ]);
    expect(t.logs).toEqual(['shared folder failed to open']);
  });
});
