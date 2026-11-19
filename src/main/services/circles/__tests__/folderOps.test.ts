import { describe, expect, it } from 'vitest';
import {
  applyFolderNodes,
  cleanPath,
  conflictPath,
  FILES_PREFIX,
  fileKey,
  FOLDER_KEY,
  type FolderDeviceIntro,
  type FolderFile,
  type FolderHost,
  type FolderOp,
  type FolderView,
  isNeverShared,
  personKey,
} from '../folderOps';

const hex = (char: string, length = 64) => char.repeat(length);

/** A device intro whose stand-in signature verifies (see `verify` below). */
function device(identity: string, writer: string, name: string, blobs = writer === 'b' ? 'f' : String.fromCharCode(writer.charCodeAt(0) + 1)): FolderDeviceIntro {
  return { identity: hex(identity), name, device: hex(identity === 'a' ? 'c' : identity), writer: hex(writer), blobs: hex(blobs), signature: hex(identity, 128) };
}

const ada = device('a', 'b', 'Ada'); // manager, blobs fff…
const bo = device('1', '2', 'Bo'); // blobs 333…
const cy = device('4', '5', 'Cy'); // blobs 666…

function harness() {
  const data = new Map<string, unknown>();
  const view: FolderView = {
    get: async (key) => (data.has(key) ? { value: data.get(key) } : null),
    put: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
    list: async (prefix) =>
      [...data.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => data.get(key)),
  };
  const writers: Array<[string, string, boolean?]> = [];
  const unremovable = new Set<string>();
  const interrupts: string[] = [];
  const host: FolderHost = {
    addWriter: async (key, { indexer }) => void writers.push(['add', key.toString('hex'), indexer]),
    removeWriter: async (key) => void writers.push(['remove', key.toString('hex')]),
    removeable: (key) => !unremovable.has(key.toString('hex')),
    interrupt: (reason) => {
      interrupts.push(reason);
      throw new Error(reason);
    },
  };
  const skipped: string[] = [];
  const run = async (author: FolderDeviceIntro, op: FolderOp, supportedFormat?: number) =>
    applyFolderNodes([{ value: op, from: { key: Buffer.from(author.writer, 'hex') } }], view, host, {
      verify: (_message, signature, publicKey) => signature[0] === publicKey[0],
      supportedFormat,
      onSkip: (reason) => skipped.push(reason),
    });
  const file = (path: string) => data.get(fileKey(path)) as FolderFile | undefined;
  const files = () =>
    [...data.keys()]
      .filter((key) => key.startsWith(FILES_PREFIX))
      .map((key) => data.get(key) as FolderFile)
      .filter((f) => !f.deleted)
      .map((f) => f.path)
      .sort();
  return { data, view, host, run, writers, skipped, unremovable, interrupts, file, files };
}

const blobOf = (who: FolderDeviceIntro, size: number) => ({ core: who.blobs, blockOffset: 0, blockLength: size ? 1 : 0, byteOffset: 0, byteLength: size });
const put = (who: FolderDeviceIntro, path: string, base: number | null, size = 4): FolderOp => ({ type: 'put', path, base, blob: blobOf(who, size), size, hash: hex('9'), at: 1000 });

async function folderWithEditors(role: 'editor' | 'reader' = 'editor') {
  const h = harness();
  await h.run(ada, { type: 'create', name: ' Cover art ', format: 1, role, member: ada });
  await h.run(ada, { type: 'add-writer', member: bo });
  return h;
}

describe('create', () => {
  it('makes the creator a manager and records the default role', async () => {
    const h = harness();
    await h.run(ada, { type: 'create', name: ' Cover art ', format: 1, role: 'editor', member: ada });
    expect(h.data.get(FOLDER_KEY)).toEqual({ name: 'Cover art', format: 1, role: 'editor', by: ada.identity });
    expect(h.data.get(personKey(ada.identity))).toEqual({ identity: ada.identity, name: 'Ada', role: 'manager' });
    expect(h.skipped).toEqual([]);
  });

  it('happens once, and only from the creator’s own writer', async () => {
    const h = harness();
    await h.run(bo, { type: 'create', name: 'Theirs', format: 1, role: 'editor', member: ada });
    await h.run(ada, { type: 'create', name: 'Mine', format: 1, role: 'editor', member: ada });
    await h.run(ada, { type: 'create', name: 'Again', format: 1, role: 'editor', member: ada });
    expect(h.skipped).toEqual(['bad creator intro', 'the folder already exists']);
    expect((h.data.get(FOLDER_KEY) as { name: string }).name).toBe('Mine');
  });

  it('refuses an intro whose signature doesn’t verify', async () => {
    const h = harness();
    await h.run(ada, { type: 'create', name: 'Mine', format: 1, role: 'editor', member: { ...ada, signature: hex('0', 128) } });
    expect(h.skipped).toEqual(['bad creator intro']);
  });

  it('stops at a format this build can’t apply', async () => {
    const h = harness();
    await expect(h.run(ada, { type: 'create', name: 'Later', format: 2, role: 'editor', member: ada }, 1)).rejects.toThrow();
    expect(h.interrupts).toEqual(['folder format 2']);
  });
});

describe('writers and roles', () => {
  it('adds an editor as a writer that doesn’t index', async () => {
    const h = await folderWithEditors();
    expect(h.writers).toEqual([['add', bo.writer, false]]);
    expect(h.data.get(personKey(bo.identity))).toEqual({ identity: bo.identity, name: 'Bo', role: 'editor' });
  });

  it('lets only managers add writers, once per writer', async () => {
    const h = await folderWithEditors();
    await h.run(bo, { type: 'add-writer', member: cy });
    await h.run(ada, { type: 'add-writer', member: bo });
    expect(h.skipped).toEqual(['only managers add writers', 'writer already in use']);
  });

  it('gives a reader no writer in a folder where people read by default', async () => {
    const h = await folderWithEditors('reader');
    expect(h.skipped).toEqual(['readers do not write']);
    expect(h.writers).toEqual([]);
  });

  it('turns a reader into an editor before their device writes', async () => {
    const h = await folderWithEditors('reader');
    await h.run(ada, { type: 'set-role', identity: bo.identity, name: 'Bo', role: 'editor' });
    await h.run(ada, { type: 'add-writer', member: bo });
    expect(h.writers).toEqual([['add', bo.writer, false]]);
  });

  it('makes a manager an indexer, and keeps the last manager', async () => {
    const h = await folderWithEditors();
    await h.run(ada, { type: 'set-role', identity: ada.identity, role: 'editor' });
    await h.run(ada, { type: 'set-role', identity: bo.identity, role: 'manager' });
    await h.run(bo, { type: 'set-role', identity: ada.identity, role: 'editor' });
    expect(h.skipped).toEqual(['the last manager stays manager']);
    expect(h.writers.slice(1)).toEqual([
      ['add', bo.writer, true],
      ['add', ada.writer, false],
    ]);
  });

  it('removes a reader’s writers, all or none', async () => {
    const h = await folderWithEditors();
    h.unremovable.add(bo.writer);
    await h.run(ada, { type: 'set-role', identity: bo.identity, role: 'reader' });
    expect(h.skipped).toEqual(['Autobase will not remove that writer']);
    h.unremovable.clear();
    await h.run(ada, { type: 'set-role', identity: bo.identity, role: 'reader' });
    expect(h.writers.at(-1)).toEqual(['remove', bo.writer]);
    await h.run(bo, put(bo, 'brief.md', null));
    expect(h.skipped.at(-1)).toBe('not a writer');
  });

  it('lets people leave and managers remove them, but not the last manager', async () => {
    const h = await folderWithEditors();
    await h.run(bo, { type: 'remove-person', identity: ada.identity });
    await h.run(ada, { type: 'remove-person', identity: ada.identity });
    await h.run(bo, { type: 'remove-person', identity: bo.identity });
    expect(h.skipped).toEqual(['only managers remove others', 'the last manager cannot be removed']);
    expect(h.data.has(personKey(bo.identity))).toBe(false);
    expect(h.writers.at(-1)).toEqual(['remove', bo.writer]);
  });
});

describe('files', () => {
  it('adds a file, then changes it from the current version', async () => {
    const h = await folderWithEditors();
    await h.run(bo, put(bo, 'brief.md', null));
    await h.run(ada, put(ada, 'brief.md', 1));
    expect(h.file('brief.md')).toMatchObject({ path: 'brief.md', version: 2, identity: ada.identity, blob: { core: ada.blobs } });
  });

  it('keeps a change made from an older version as a conflict copy named for its author', async () => {
    const h = await folderWithEditors();
    await h.run(ada, put(ada, 'brief.md', null));
    await h.run(ada, put(ada, 'brief.md', 1));
    await h.run(bo, put(bo, 'brief.md', 1));
    await h.run(bo, put(bo, 'brief.md', 1));
    expect(h.files()).toEqual(['brief (conflict, Bo 2).md', 'brief (conflict, Bo).md', 'brief.md']);
    expect(h.file('brief (conflict, Bo).md')).toMatchObject({ version: 1, conflictOf: 'brief.md', identity: bo.identity });
    expect(h.file('brief.md')?.version).toBe(2);
  });

  it('treats a create that crossed another create as a conflict', async () => {
    const h = await folderWithEditors();
    await h.run(ada, put(ada, 'notes.md', null));
    await h.run(bo, put(bo, 'notes.md', null));
    expect(h.files()).toEqual(['notes (conflict, Bo).md', 'notes.md']);
  });

  it('compares paths without case, keeping the first spelling', async () => {
    const h = await folderWithEditors();
    await h.run(ada, put(ada, 'Notes.md', null));
    await h.run(bo, put(bo, 'notes.md', 1));
    expect(h.files()).toEqual(['Notes.md']);
    expect(h.file('NOTES.MD')).toMatchObject({ version: 2, identity: bo.identity });
  });

  it('compares paths after NFC, so both spellings of é are one file', async () => {
    const h = await folderWithEditors();
    await h.run(ada, put(ada, 'Résumé.md', null));
    await h.run(bo, put(bo, 'Résumé.md', 1));
    expect(h.files()).toEqual(['Résumé.md']);
  });

  it('deletes from the current version, and an edit that crossed a delete brings the file back', async () => {
    const h = await folderWithEditors();
    await h.run(ada, put(ada, 'brief.md', null));
    await h.run(ada, { type: 'del', path: 'brief.md', base: 1, at: 1100 });
    expect(h.file('brief.md')).toMatchObject({ deleted: true, version: 2 });
    expect(h.files()).toEqual([]);
    await h.run(bo, put(bo, 'brief.md', 1));
    expect(h.file('brief.md')).toMatchObject({ deleted: false, version: 3, identity: bo.identity });
  });

  it('skips a delete made before someone else’s change', async () => {
    const h = await folderWithEditors();
    await h.run(ada, put(ada, 'brief.md', null));
    await h.run(ada, put(ada, 'brief.md', 1));
    await h.run(bo, { type: 'del', path: 'brief.md', base: 1, at: 1100 });
    await h.run(bo, { type: 'del', path: 'gone.md', base: 1, at: 1100 });
    expect(h.skipped).toEqual(['file changed since', 'no such file']);
    expect(h.files()).toEqual(['brief.md']);
  });

  it('refuses paths that can’t be shared or are never shared', async () => {
    const h = await folderWithEditors();
    for (const path of ['/abs.md', 'a//b.md', './a.md', 'a/../b.md', 'a\\b.md', 'tab\there.md', '', 'x'.repeat(1025)]) await h.run(bo, put(bo, path, null));
    expect(h.skipped).toEqual(Array(8).fill('bad path'));
    h.skipped.length = 0;
    for (const path of ['.env', 'site/.env.local', '.git/config', 'web/node_modules/x/index.js', 'covers/.DS_Store']) await h.run(bo, put(bo, path, null));
    expect(h.skipped).toEqual(Array(5).fill('path is never shared'));
    await h.run(bo, put(bo, '.env.example', null));
    expect(h.files()).toEqual(['.env.example']);
  });

  it('takes contents only from the author’s own blob core, within the size limit', async () => {
    const h = await folderWithEditors();
    await h.run(bo, { ...(put(bo, 'a.md', null) as Extract<FolderOp, { type: 'put' }>), blob: blobOf(ada, 4) });
    await h.run(bo, { ...(put(bo, 'a.md', null) as Extract<FolderOp, { type: 'put' }>), size: 5 });
    await h.run(bo, put(bo, 'big.mov', null, 100 * 1024 * 1024 + 1));
    await h.run(bo, { ...(put(bo, 'a.md', null) as Extract<FolderOp, { type: 'put' }>), hash: 'nope' });
    expect(h.skipped).toEqual(['bad blob', 'bad blob', 'bad size', 'bad hash']);
    await h.run(bo, put(bo, 'empty.md', null, 0));
    expect(h.files()).toEqual(['empty.md']);
  });

  it('ignores writes from devices that aren’t writers', async () => {
    const h = await folderWithEditors();
    await h.run(cy, put(cy, 'a.md', null));
    expect(h.skipped).toEqual(['not a writer']);
  });
});

describe('format', () => {
  it('only rises, only by a manager', async () => {
    const h = await folderWithEditors();
    await h.run(bo, { type: 'set-format', format: 2 });
    await h.run(ada, { type: 'set-format', format: 1 });
    expect(h.skipped).toEqual(['only managers change the format', 'formats only rise']);
    await expect(h.run(ada, { type: 'set-format', format: 2 }, 1)).rejects.toThrow();
    expect(h.interrupts).toEqual(['folder format 2']);
  });
});

describe('path helpers', () => {
  it('cleans paths to NFC', () => {
    expect(cleanPath('café/menu.md')).toBe('café/menu.md');
    expect(cleanPath(42)).toBeNull();
  });

  it('knows which files stay on their Mac', () => {
    expect(isNeverShared('.env')).toBe(true);
    expect(isNeverShared('a/.env.production')).toBe(true);
    expect(isNeverShared('a/.env.template')).toBe(false);
    expect(isNeverShared('node_modules')).toBe(true);
    expect(isNeverShared('docs/git-notes.md')).toBe(false);
  });

  it('names conflict copies beside the original', () => {
    expect(conflictPath('covers/brief.md', 'Sam', 1)).toBe('covers/brief (conflict, Sam).md');
    expect(conflictPath('Makefile', 'Sam', 2)).toBe('Makefile (conflict, Sam 2)');
    expect(conflictPath('.gitignore', 'Sam', 1)).toBe('.gitignore (conflict, Sam)');
    expect(conflictPath('a.tar.gz', 'S/a\\m', 1)).toBe('a.tar (conflict, S a m).gz');
  });
});
