import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderMirror, type MirrorFolder, type MirrorKnown, type MirrorStatus } from '../folderMirror';
import {
  applyFolderNodes,
  FILES_PREFIX,
  type FolderDeviceIntro,
  type FolderFile,
  type FolderOp,
  type FolderRole,
  type FolderView,
} from '../folderOps';

const hex = (char: string, length = 64) => char.repeat(length);
const intro = (identity: string, writer: string, blobs: string, name: string): FolderDeviceIntro => ({
  identity: hex(identity),
  name,
  device: hex(identity),
  writer: hex(writer),
  blobs: hex(blobs),
  signature: hex(identity, 128),
});
const maya = intro('a', 'b', 'c', 'Maya');
const me = intro('1', '2', '3', 'Jordan');

/**
 * A shared folder in memory that applies operations with the real `applyFolderNodes`, so conflict
 * copies and stale deletes behave as they do in a folder's Autobase.
 */
class FakeFolder implements MirrorFolder {
  readonly data = new Map<string, unknown>();
  readonly blobs = new Map<number, Buffer>();
  readonly sent: Array<{ type: string; path: string; base: number | null }> = [];
  /** Paths whose contents no connected peer holds yet. */
  readonly unavailable = new Set<string>();
  private readonly waiters = new Map<string, () => void>();
  private readonly view: FolderView = {
    get: async (key) => (this.data.has(key) ? { value: this.data.get(key) } : null),
    put: async (key, value) => void this.data.set(key, value),
    del: async (key) => void this.data.delete(key),
    list: async (prefix) =>
      [...this.data.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => this.data.get(key)),
  };

  constructor(private readonly myRole: FolderRole) {}

  async init(): Promise<void> {
    await this.apply(maya, { type: 'create', name: 'Cover art', format: 1, role: this.myRole === 'reader' ? 'reader' : 'editor', member: maya });
    if (this.myRole !== 'reader') await this.apply(maya, { type: 'add-writer', member: me });
  }

  async apply(who: FolderDeviceIntro, op: FolderOp): Promise<void> {
    await applyFolderNodes([{ value: op, from: { key: Buffer.from(who.writer, 'hex') } }], this.view, {
      addWriter: async () => {},
      removeWriter: async () => {},
      removeable: () => true,
      interrupt: () => {},
    }, { verify: () => true });
  }

  /** Someone else writes a file. */
  async remotePut(path: string, text: string, base: number | null): Promise<void> {
    await this.apply(maya, this.putOp(maya, path, Buffer.from(text), base));
  }

  private putOp(who: FolderDeviceIntro, filePath: string, data: Buffer, base: number | null): FolderOp {
    const id = this.blobs.size;
    this.blobs.set(id, data);
    return {
      type: 'put',
      path: filePath,
      base,
      blob: { core: who.blobs, blockOffset: id, blockLength: data.length ? 1 : 0, byteOffset: 0, byteLength: data.length },
      size: data.length,
      hash: crypto.hash(data).toString('hex'),
      at: 1,
    };
  }

  async files(): Promise<FolderFile[]> {
    return (await this.view.list(FILES_PREFIX)) as FolderFile[];
  }
  async file(p: string): Promise<FolderFile | null> {
    return (await this.files()).find((f) => f.path.toLowerCase() === p.normalize('NFC').toLowerCase()) ?? null;
  }
  async live(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of await this.files()) if (!f.deleted) out[f.path] = String(this.blobs.get(f.blob!.blockOffset));
    return out;
  }
  async read(p: string, opts: { wait?: boolean } = {}): Promise<Buffer | null> {
    const f = await this.file(p);
    if (!f || f.deleted) return null;
    if (this.unavailable.has(f.path)) {
      if (opts.wait === false) return null;
      await new Promise<void>((resolve) => this.waiters.set(f.path, resolve));
    }
    return this.blobs.get(f.blob!.blockOffset) ?? null;
  }
  /** A peer that holds `path` connects. */
  arrive(p: string): void {
    this.unavailable.delete(p);
    this.waiters.get(p)?.();
  }
  async put(p: string, data: Buffer, base: number | null): Promise<void> {
    this.sent.push({ type: 'put', path: p, base });
    await this.apply(me, this.putOp(me, p, data, base));
  }
  async del(p: string, base: number): Promise<void> {
    this.sent.push({ type: 'del', path: p, base });
    await this.apply(me, { type: 'del', path: p, base, at: 1 });
  }
  async role(): Promise<FolderRole | null> {
    return this.myRole;
  }
}

let root: string;
let saved: MirrorKnown;
const mirrors: FolderMirror[] = [];
let emit: (rel: string) => void;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'folder-mirror-'));
  saved = {};
});

afterEach(async () => {
  vi.useRealTimers();
  for (const m of mirrors.splice(0)) await m.stop();
  await rm(root, { recursive: true, force: true });
});

async function mirror(folder: FakeFolder, onStatus?: (status: MirrorStatus) => void): Promise<FolderMirror> {
  const m = new FolderMirror({
    root,
    folder,
    load: async () => structuredClone(saved),
    save: async (known) => void (saved = structuredClone(known)),
    quietMs: 2000,
    rescanMs: 60_000,
    watch: (_root, onPath) => {
      emit = onPath;
      return { close: () => {} };
    },
    now: () => 5,
    onStatus,
  });
  mirrors.push(m);
  await m.start();
  return m;
}

const disk = (p: string) => readFile(path.join(root, p), 'utf8');
const put = (p: string, text: string) => mkdir(path.dirname(path.join(root, p)), { recursive: true }).then(() => writeFile(path.join(root, p), text));

async function editor() {
  const folder = new FakeFolder('editor');
  await folder.init();
  return folder;
}

describe('starting', () => {
  it('writes the folder’s files to disk', async () => {
    const folder = await editor();
    await folder.remotePut('brief.md', 'Option 2', null);
    await folder.remotePut('covers/option-1.png', 'png', null);
    await mirror(folder);
    expect(await disk('brief.md')).toBe('Option 2');
    expect(await disk('covers/option-1.png')).toBe('png');
    expect(Object.keys(saved).sort()).toEqual(['brief.md', 'covers/option-1.png']);
    expect(folder.sent).toEqual([]);
  });

  it('shares files already in the folder on this Mac', async () => {
    const folder = await editor();
    await put('notes.md', 'mine');
    await mirror(folder);
    expect(folder.sent).toEqual([{ type: 'put', path: 'notes.md', base: null }]);
    expect(await folder.live()).toEqual({ 'notes.md': 'mine' });
  });

  it('picks up an edit made while Boundary was closed, from the version it knew', async () => {
    const folder = await editor();
    await folder.remotePut('brief.md', 'v1', null);
    const first = await mirror(folder);
    await first.stop();
    await put('brief.md', 'v2 offline');
    await mirror(folder);
    expect(folder.sent).toEqual([{ type: 'put', path: 'brief.md', base: 1 }]);
    expect((await folder.file('brief.md'))?.version).toBe(2);
  });
});

describe('changes on disk', () => {
  it('waits until a path has been quiet, then sends one change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const folder = await editor();
    const m = await mirror(folder);
    await put('draft.md', 'a');
    emit('draft.md');
    await vi.advanceTimersByTimeAsync(1500);
    await put('draft.md', 'ab');
    emit('draft.md');
    await vi.advanceTimersByTimeAsync(1999);
    await m.idle();
    expect(folder.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await m.idle();
    expect(folder.sent).toEqual([{ type: 'put', path: 'draft.md', base: null }]);
    expect(await folder.live()).toEqual({ 'draft.md': 'ab' });
  });

  it('sends a delete made from the current version', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const folder = await editor();
    await folder.remotePut('old.md', 'x', null);
    const m = await mirror(folder);
    await rm(path.join(root, 'old.md'));
    emit('old.md');
    await vi.advanceTimersByTimeAsync(2000);
    await m.idle();
    expect(folder.sent).toEqual([{ type: 'del', path: 'old.md', base: 1 }]);
    expect(await folder.live()).toEqual({});
  });

  it('looks under a folder that was renamed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const folder = await editor();
    const m = await mirror(folder);
    await put('covers/a.png', '1');
    await put('covers/b.png', '2');
    emit('covers');
    await vi.advanceTimersByTimeAsync(2000);
    await m.idle();
    expect(Object.keys(await folder.live()).sort()).toEqual(['covers/a.png', 'covers/b.png']);
  });

  it('keeps unshared files on this Mac and says why', async () => {
    const folder = await editor();
    await put('.env', 'SECRET=1');
    await put('web/node_modules/x/index.js', 'x');
    await symlink('/etc/hosts', path.join(root, 'hosts'));
    const m = await mirror(folder);
    expect(folder.sent).toEqual([]);
    expect(m.status().unshared).toEqual([
      { path: '.env', reason: 'never-shared' },
      { path: 'hosts', reason: 'link' },
      { path: 'web/node_modules/', reason: 'never-shared' },
    ]);
  });
});

describe('changes from others', () => {
  it('writes a new version over an unchanged file', async () => {
    const folder = await editor();
    await folder.remotePut('brief.md', 'v1', null);
    const m = await mirror(folder);
    await folder.remotePut('brief.md', 'v2 from Maya', 1);
    await m.viewChanged();
    expect(await disk('brief.md')).toBe('v2 from Maya');
    expect(folder.sent).toEqual([]);
  });

  it('removes a file someone else deleted', async () => {
    const folder = await editor();
    await folder.remotePut('old.md', 'x', null);
    const m = await mirror(folder);
    await folder.apply(maya, { type: 'del', path: 'old.md', base: 1, at: 1 });
    await m.viewChanged();
    await expect(stat(path.join(root, 'old.md'))).rejects.toThrow();
  });

  it('turns crossed edits into a conflict copy that every Mac gets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const folder = await editor();
    await folder.remotePut('brief.md', 'v1', null);
    const m = await mirror(folder);
    await folder.remotePut('brief.md', 'Maya’s edit', 1);
    await put('brief.md', 'my edit');
    emit('brief.md');
    await vi.advanceTimersByTimeAsync(2000);
    await m.idle();
    await m.viewChanged();
    expect(folder.sent).toEqual([{ type: 'put', path: 'brief.md', base: 1 }]);
    expect(await disk('brief.md')).toBe('Maya’s edit');
    expect(await disk('brief (conflict, Jordan).md')).toBe('my edit');
  });

  it('brings back a file deleted here that someone else changed', async () => {
    const folder = await editor();
    await folder.remotePut('brief.md', 'v1', null);
    const first = await mirror(folder);
    await first.stop();
    await rm(path.join(root, 'brief.md'));
    await folder.remotePut('brief.md', 'v2', 1);
    await mirror(folder);
    expect(await disk('brief.md')).toBe('v2');
    expect(folder.sent).toEqual([]);
  });

  it('waits for contents no peer holds, then writes them', async () => {
    const folder = await editor();
    await folder.remotePut('big.pdf', 'pdf', null);
    folder.unavailable.add('big.pdf');
    let settled!: () => void;
    const written = new Promise<void>((resolve) => (settled = resolve));
    const m = await mirror(folder, (status) => status.waiting === 0 && settled());
    expect(m.status().waiting).toBe(1);
    await expect(stat(path.join(root, 'big.pdf'))).rejects.toThrow();
    folder.arrive('big.pdf');
    await written;
    expect(await disk('big.pdf')).toBe('pdf');
  });
});

describe('as a reader', () => {
  it('writes read-only files and never sends a change', async () => {
    const folder = new FakeFolder('reader');
    await folder.init();
    await folder.remotePut('contract.pdf', 'v1', null);
    const m = await mirror(folder);
    expect((await stat(path.join(root, 'contract.pdf'))).mode & 0o222).toBe(0);
    await chmod(path.join(root, 'contract.pdf'), 0o644);
    await put('contract.pdf', 'my notes');
    await put('mine.md', 'new');
    await m.stop();
    await mirror(folder);
    expect(folder.sent).toEqual([]);
    const second = mirrors.at(-1)!;
    expect(second.status().unshared).toEqual([
      { path: 'contract.pdf', reason: 'reader-change' },
      { path: 'mine.md', reason: 'reader-change' },
    ]);
  });

  it('keeps a reader’s change beside a new version', async () => {
    const folder = new FakeFolder('reader');
    await folder.init();
    await folder.remotePut('contract.pdf', 'v1', null);
    const m = await mirror(folder);
    await chmod(path.join(root, 'contract.pdf'), 0o644);
    await put('contract.pdf', 'my notes');
    await folder.remotePut('contract.pdf', 'v2', 1);
    await m.viewChanged();
    expect(await disk('contract.pdf')).toBe('v2');
    expect(await disk('contract (conflict, this Mac).pdf')).toBe('my notes');
    expect(folder.sent).toEqual([]);
  });
});
