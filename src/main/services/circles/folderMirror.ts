/**
 * Keeps a real folder on this Mac in step with a shared folder's view (ADR 0049 §8–§11). People,
 * their editors and their agents use the folder like any other; the mirror turns what changes on
 * disk into folder operations and writes what others change back to disk.
 *
 * For each path it compares three things: the file on disk, the file in the view, and what the
 * mirror last knew both to be (`known`, kept across launches). A side that differs from `known`
 * changed. When only the view changed, the mirror writes it to disk; when only the disk changed,
 * it sends the change made from the version it knew, and `apply` turns a change that crossed
 * another into a conflict copy (folderOps.ts), which then arrives here like any other file.
 *
 * `fs.watch` events are hints: their type doesn't say what happened, so every event means "look at
 * this path", after it has been quiet for `quietMs`. A full scan runs at start and every
 * `rescanMs`, which also picks up whatever changed while Boundary was closed (shared-folders-modules.md).
 *
 * Paths and contents are never logged.
 */

import { watch as fsWatch } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import type { UnsharedFile } from '../../../shared/types/sharedFolders';
import { createSerialQueue } from '../../../shared/utils/serialQueue';
import { cleanPath, conflictPath, type FolderFile, type FolderRole, isNeverShared, MAX_FILE_BYTES } from './folderOps';

/** One shared folder, as the mirror uses it. `SharedFolders` provides it for an open folder. */
export interface MirrorFolder {
  files(): Promise<FolderFile[]>;
  file(path: string): Promise<FolderFile | null>;
  read(path: string, opts?: { wait?: boolean }): Promise<Buffer | null>;
  put(path: string, data: Buffer, base: number | null, at: number): Promise<void>;
  del(path: string, base: number, at: number): Promise<void>;
  role(): Promise<FolderRole | null>;
}

/** What the mirror last knew a path to be on both sides. */
export interface KnownFile {
  path: string;
  version: number;
  hash: string;
}

/** Known files by folded path, kept across launches. */
export type MirrorKnown = Record<string, KnownFile>;


export interface MirrorStatus {
  /** Files on this Mac that the folder doesn't get, and why (ADR 0049 §9). */
  unshared: UnsharedFile[];
  /** Files whose current version no connected peer holds yet. */
  waiting: number;
}

export interface FolderMirrorOptions {
  /** The folder on this Mac. Created if missing. */
  root: string;
  folder: MirrorFolder;
  load(): Promise<MirrorKnown>;
  save(known: MirrorKnown): Promise<void>;
  /** How long a path must be quiet before the mirror looks at it, in ms. */
  quietMs?: number;
  /** How often the whole folder is scanned while running, in ms. */
  rescanMs?: number;
  /** Stands in for `fs.watch` in tests. Calls `onPath` with a path relative to `root`. */
  watch?: (root: string, onPath: (relative: string) => void) => { close(): void };
  now?: () => number;
  onStatus?: (status: MirrorStatus) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** Prefix of the temporary files remote changes are written to before being renamed into place. */
const TEMP_PREFIX = '.boundary-sync-';
const DEFAULT_QUIET_MS = 2000;
/** A starting value, to tune once real folders exist (shared-folders-modules.md). */
const DEFAULT_RESCAN_MS = 10 * 60 * 1000;

const fold = (p: string): string => p.normalize('NFC').toLowerCase();
const hashOf = (data: Buffer): string => crypto.hash(data).toString('hex');

interface LocalFile {
  path: string;
  hash: string | null;
  unshared?: UnsharedFile['reason'];
}

function defaultWatch(root: string, onPath: (relative: string) => void): { close(): void } {
  const watcher = fsWatch(root, { recursive: true }, (_type, name) => {
    if (name) onPath(String(name));
  });
  return { close: () => watcher.close() };
}

export class FolderMirror {
  private known: MirrorKnown = {};
  private readonly unshared = new Map<string, UnsharedFile>();
  private readonly waiting = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queue = createSerialQueue();
  private tail: Promise<unknown> = Promise.resolve();
  private watcher: { close(): void } | null = null;
  private rescan: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private rootReal = '';

  constructor(private readonly options: FolderMirrorOptions) {}

  private get root(): string {
    return this.options.root;
  }

  /** Load what the mirror knew, bring the folder up to date, and start watching it. */
  async start(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.rootReal = await realpath(this.root);
    this.known = await this.options.load();
    this.watcher = (this.options.watch ?? defaultWatch)(this.root, (relative) => this.onPath(relative));
    this.rescan = setInterval(() => void this.enqueue(() => this.syncAll()), this.options.rescanMs ?? DEFAULT_RESCAN_MS);
    await this.enqueue(() => this.syncAll());
  }

  /** The folder's view changed: write what others changed. */
  viewChanged(): Promise<void> {
    return this.enqueue(() => this.syncRemote());
  }

  /** Resolves once everything queued so far has run. */
  idle(): Promise<void> {
    return this.tail.then((): void => undefined);
  }

  status(): MirrorStatus {
    return { unshared: [...this.unshared.values()].sort((a, b) => (a.path < b.path ? -1 : 1)), waiting: this.waiting.size };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    if (this.rescan) clearInterval(this.rescan);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.idle();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue(async () => {
      if (this.stopped) return;
      try {
        await work();
      } catch (error) {
        this.options.log?.('shared folder sync failed', { error: (error as Error).message });
      }
      this.options.onStatus?.(this.status());
    });
    this.tail = run;
    return run;
  }

  private onPath(relative: string): void {
    const rel = relative.split(path.sep).join('/');
    if (!rel || path.basename(rel).startsWith(TEMP_PREFIX)) return;
    const key = fold(rel);
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.enqueue(() => this.syncUnder(rel));
      }, this.options.quietMs ?? DEFAULT_QUIET_MS)
    );
  }

  /** Every file under the root, by folded path. Links aren't followed, and temporary files are skipped. */
  private async scan(dir = ''): Promise<Map<string, LocalFile>> {
    const out = new Map<string, LocalFile>();
    let entries;
    try {
      entries = await readdir(path.join(this.root, dir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(TEMP_PREFIX)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isNeverShared(rel)) {
          this.unshared.set(fold(rel), { path: `${rel}/`, reason: 'never-shared' });
          continue;
        }
        for (const [key, file] of await this.scan(rel)) out.set(key, file);
      } else {
        out.set(fold(rel), await this.local(rel));
      }
    }
    return out;
  }

  /** One path on disk: its hash, or why it isn't shared, or a null hash when it isn't there. */
  private async local(rel: string): Promise<LocalFile> {
    const clean = cleanPath(rel);
    if (!clean) return { path: rel, hash: null, unshared: 'never-shared' };
    let stats;
    try {
      stats = await lstat(path.join(this.root, clean));
    } catch {
      return { path: clean, hash: null };
    }
    if (stats.isSymbolicLink()) return { path: clean, hash: null, unshared: 'link' };
    if (!stats.isFile()) return { path: clean, hash: null };
    if (isNeverShared(clean)) return { path: clean, hash: null, unshared: 'never-shared' };
    if (stats.size > MAX_FILE_BYTES) return { path: clean, hash: null, unshared: 'too-large' };
    return { path: clean, hash: hashOf(await readFile(path.join(this.root, clean))) };
  }

  private async syncAll(): Promise<void> {
    const local = await this.scan();
    const view = new Map((await this.options.folder.files()).map((file) => [fold(file.path), file]));
    const keys = new Set([...local.keys(), ...view.keys(), ...Object.keys(this.known)]);
    const writable = await this.canWrite();
    for (const key of [...keys].sort()) {
      const file = local.get(key) ?? { path: view.get(key)?.path ?? this.known[key]?.path ?? key, hash: null };
      await this.reconcile(key, file, view.get(key) ?? null, writable);
    }
    await this.options.save(this.known);
  }

  /** Only the view changed: look at paths whose version moved since the mirror last knew them. */
  private async syncRemote(): Promise<void> {
    const writable = await this.canWrite();
    for (const file of await this.options.folder.files()) {
      const key = fold(file.path);
      const known = this.known[key];
      if (known && known.version === file.version && !this.waiting.has(key)) continue;
      await this.reconcile(key, await this.local(file.path), file, writable);
    }
    await this.options.save(this.known);
  }

  /** An event named this path: look at it, and at everything under it if it is or was a folder. */
  private async syncUnder(rel: string): Promise<void> {
    const prefix = `${fold(rel)}/`;
    const under = await this.scan(rel);
    const keys = new Set([fold(rel), ...under.keys(), ...Object.keys(this.known).filter((key) => key.startsWith(prefix))]);
    const writable = await this.canWrite();
    for (const key of [...keys].sort()) {
      const view = await this.options.folder.file(this.known[key]?.path ?? under.get(key)?.path ?? rel);
      const file = under.get(key) ?? (await this.local(this.known[key]?.path ?? view?.path ?? rel));
      await this.reconcile(key, file, view, writable);
    }
    await this.options.save(this.known);
  }

  private async canWrite(): Promise<boolean> {
    const role = await this.options.folder.role();
    return role === 'manager' || role === 'editor';
  }

  private async reconcile(key: string, disk: LocalFile, view: FolderFile | null, writable: boolean): Promise<void> {
    if (disk.unshared) {
      this.unshared.set(key, { path: disk.path, reason: disk.unshared });
      return;
    }
    if (this.unshared.get(key)?.reason !== 'reader-change') this.unshared.delete(key);
    const known = this.known[key] ?? null;
    const remote = view && !view.deleted ? view : null;
    const localHash = disk.hash;

    if (localHash === (remote?.hash ?? null)) {
      this.unshared.delete(key);
      this.waiting.delete(key);
      if (remote) this.known[key] = { path: remote.path, version: remote.version, hash: remote.hash! };
      else delete this.known[key];
      return;
    }
    const localChanged = localHash !== (known?.hash ?? null);
    const remoteChanged = (view?.version ?? 0) !== (known?.version ?? 0);

    if (localChanged && writable) {
      if (localHash !== null) {
        const data = await readFile(path.join(this.root, disk.path));
        // The version this edit was made from; apply keeps it as a copy if another change came first.
        await this.options.folder.put(disk.path, data, known?.version ?? null, this.now());
        this.known[key] = { path: disk.path, version: known?.version ?? 0, hash: hashOf(data) };
      } else if (remote && known && !remoteChanged) {
        await this.options.folder.del(remote.path, remote.version, this.now());
      } else if (!remote) {
        delete this.known[key];
      } else {
        // Deleted here while someone changed it: their change wins and comes back.
        await this.writeRemote(key, remote, false);
      }
      return;
    }

    if (localChanged && !writable) {
      if (!remoteChanged) {
        if (localHash !== null) this.unshared.set(key, { path: disk.path, reason: 'reader-change' });
        return;
      }
      // A reader's change stays on this Mac, beside the new version (ADR 0049 §8).
      if (localHash !== null) {
        const copy = conflictPath(disk.path, 'this Mac', 1);
        await rename(path.join(this.root, disk.path), path.join(this.root, copy));
        this.unshared.set(fold(copy), { path: copy, reason: 'reader-change' });
      }
      this.unshared.delete(key);
    }

    if (remote) await this.writeRemote(key, remote, !writable);
    else {
      await rm(path.join(this.root, disk.path), { force: true });
      delete this.known[key];
    }
  }

  /** Writes a file's current version to disk by a temporary file and a rename. */
  private async writeRemote(key: string, remote: FolderFile, readOnly: boolean): Promise<void> {
    const data = await this.options.folder.read(remote.path, { wait: false });
    if (!data) {
      // No connected peer holds it yet: fetch it in the background and look again when it lands.
      if (!this.waiting.has(key)) {
        this.waiting.add(key);
        void this.options.folder
          .read(remote.path)
          .then(() => this.enqueue(() => this.syncRemote()))
          .catch(() => this.waiting.delete(key));
      }
      return;
    }
    const target = path.join(this.root, remote.path);
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });
    // A link inside the folder must not carry a write outside it.
    const dirReal = await realpath(dir);
    if (dirReal !== this.rootReal && !dirReal.startsWith(`${this.rootReal}${path.sep}`)) {
      this.unshared.set(key, { path: remote.path, reason: 'link' });
      return;
    }
    const temp = path.join(dir, `${TEMP_PREFIX}${crypto.randomBytes(8).toString('hex')}`);
    await writeFile(temp, data);
    if (readOnly) await chmod(temp, 0o444);
    await rename(temp, target);
    this.waiting.delete(key);
    this.known[key] = { path: remote.path, version: remote.version, hash: remote.hash! };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
