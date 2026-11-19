/**
 * Shared folders in the network process (ADR 0049 §2–§4). Each folder is its own Autobase in its
 * own Corestore namespace, encrypted with its own key; each writer device keeps the contents it
 * writes in a blob core of its own, encrypted with the same key. The Corestore is the one Circles
 * replicate over every member connection, so folders replicate over those connections too.
 *
 * This holds no policy: which folders to open and who may write is decided by main and the
 * folder's managers. Paths and contents are never logged (ADR 0049 §14).
 */

import Autobase, { type AutobaseHost } from 'autobase';
import type Corestore from 'corestore';
import type { Hypercore } from 'corestore';
import Hyperbee from 'hyperbee';
import Hyperblobs from 'hyperblobs';
import crypto from 'hypercore-crypto';
import { beeView } from './autobaseApply';
import type { MirrorFolder } from './folderMirror';
import {
  applyFolderNodes,
  cleanPath,
  FILES_PREFIX,
  fileKey,
  FOLDER_FORMAT,
  FOLDER_KEY,
  folderDeviceProof,
  type FolderDeviceIntro,
  type FolderFile,
  type FolderHeader,
  type FolderOp,
  type FolderPerson,
  type FolderRole,
  type FolderView,
  isNeverShared,
  MAX_FILE_BYTES,
  PEOPLE_PREFIX,
  personKey,
  WRITERS_PREFIX,
  type FolderWriter,
} from './folderOps';

/** What a device keeps to reopen a folder. Hex strings. */
/** One version of a file, as its put sits in the view's history. */
export interface FolderChange extends FolderFile {
  /** Its block in the view, newest highest. */
  seq: number;
  /** Enough managers have seen it that its order is final (ADR 0049 §5). */
  confirmed: boolean;
}

/** How far back a history read looks, so a long-lived folder answers quickly. */
const HISTORY_SCAN_LIMIT = 20_000;
/** Text compared in the conflict sheet; larger files are compared by size and time only. */
const COMPARE_MAX_BYTES = 512 * 1024;

export interface FolderSecrets {
  key: string;
  encryptionKey: string;
  /** This device's Corestore namespace for the folder. */
  namespace: string;
}

export interface SharedFoldersOptions {
  store: Corestore;
  identity: { publicKey: Buffer; secretKey: Buffer };
  device: { publicKey: Buffer; secretKey: Buffer };
  /** The name other members see. */
  name: () => string;
  /** How often a manager's device acks, in ms. */
  ackInterval?: number;
  /** Stands in for a build with a different `FOLDER_FORMAT`, in tests. */
  supportedFormat?: number;
  /** A folder's view may have changed. */
  onChange?: (key: string) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

interface OpenFolder {
  secrets: FolderSecrets;
  base: Autobase<Hyperbee>;
  blobs: Hyperblobs;
  view: FolderView;
}

export class SharedFolders {
  private readonly folders = new Map<string, OpenFolder>();
  /** Other devices' blob cores, by core key. */
  private readonly remoteBlobs = new Map<string, Hyperblobs>();

  constructor(private readonly options: SharedFoldersOptions) {}

  private get identityHex(): string {
    return this.options.identity.publicKey.toString('hex');
  }

  private async boot(secrets: FolderSecrets | null): Promise<OpenFolder> {
    const namespace = secrets?.namespace ?? crypto.randomBytes(16).toString('hex');
    const ns = this.options.store.namespace(`folder-${namespace}`);
    const base = new Autobase<Hyperbee>(ns, secrets ? Buffer.from(secrets.key, 'hex') : null, {
      encrypt: true,
      encryptionKey: secrets ? Buffer.from(secrets.encryptionKey, 'hex') : undefined,
      ackInterval: this.options.ackInterval ?? 10_000,
      valueEncoding: 'json',
      open: (viewStore) =>
        new Hyperbee(viewStore.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: (nodes, view, host: AutobaseHost) =>
        applyFolderNodes(nodes, beeView(view), host, {
          verify: (message, signature, publicKey) => crypto.verify(message, signature, publicKey),
          supportedFormat: this.options.supportedFormat ?? FOLDER_FORMAT,
          onSkip: (reason) => this.options.log?.('folder op skipped', { reason }),
        }),
    });
    await base.ready();
    const encryptionKey = base.encryptionKey!;
    const blobCore = ns.get({ name: 'blobs', encryption: { key: encryptionKey } });
    await blobCore.ready();
    const open: OpenFolder = {
      secrets: { key: base.key.toString('hex'), encryptionKey: encryptionKey.toString('hex'), namespace },
      base,
      blobs: new Hyperblobs(blobCore),
      view: beeView(base.view),
    };
    base.on('update', () => this.options.onChange?.(open.secrets.key));
    this.folders.set(open.secrets.key, open);
    return open;
  }

  private folder(key: string): OpenFolder {
    const open = this.folders.get(key);
    if (!open) throw new Error('That folder is not open on this device');
    return open;
  }

  /** This device's intro for a folder, signed by its identity, for a manager to add as a writer. */
  intro(key: string): FolderDeviceIntro {
    const open = this.folder(key);
    const device = this.options.device.publicKey.toString('hex');
    const writer = open.base.local!.key.toString('hex');
    const blobs = open.blobs.core.key.toString('hex');
    const signature = crypto.sign(folderDeviceProof(device, writer, blobs), this.options.identity.secretKey);
    return { identity: this.identityHex, name: this.options.name(), device, writer, blobs, signature: signature.toString('hex') };
  }

  /** Start a folder with this device as its first manager. */
  async create(name: string, role: Exclude<FolderRole, 'manager'>): Promise<FolderSecrets> {
    const open = await this.boot(null);
    await this.append(open, { type: 'create', name, format: FOLDER_FORMAT, role, member: this.intro(open.secrets.key) });
    return open.secrets;
  }

  /** Open a folder this device created or was offered. It replicates from then on. */
  async open(secrets: FolderSecrets): Promise<void> {
    if (this.folders.has(secrets.key)) return;
    await this.boot(secrets);
  }

  /** Stop replicating a folder this device removed. Its blocks stay until the store is cleaned. */
  async closeFolder(key: string): Promise<void> {
    const open = this.folders.get(key);
    if (!open) return;
    this.folders.delete(key);
    await open.blobs.core.close().catch(() => {});
    await open.base.close().catch(() => {});
  }

  isOpen(key: string): boolean {
    return this.folders.has(key);
  }

  writable(key: string): boolean {
    return this.folder(key).base.writable;
  }

  async header(key: string): Promise<FolderHeader | null> {
    return ((await this.folder(key).view.get(FOLDER_KEY))?.value as FolderHeader) ?? null;
  }

  async people(key: string): Promise<FolderPerson[]> {
    return (await this.folder(key).view.list(PEOPLE_PREFIX)) as FolderPerson[];
  }

  async writers(key: string): Promise<FolderWriter[]> {
    return (await this.folder(key).view.list(WRITERS_PREFIX)) as FolderWriter[];
  }

  /** Every file the view holds, deleted ones as tombstones, in folded-path order. */
  async files(key: string): Promise<FolderFile[]> {
    return (await this.folder(key).view.list(FILES_PREFIX)) as FolderFile[];
  }

  async file(key: string, path: string): Promise<FolderFile | null> {
    const clean = cleanPath(path);
    if (!clean) return null;
    return ((await this.folder(key).view.get(fileKey(clean)))?.value as FolderFile) ?? null;
  }

  /** What this device's own role is, once the view knows it. */
  async role(key: string): Promise<FolderRole | null> {
    const person = (await this.folder(key).view.get(personKey(this.identityHex)))?.value as FolderPerson | undefined;
    return person?.role ?? null;
  }

  async addWriter(key: string, member: FolderDeviceIntro): Promise<void> {
    await this.append(this.folder(key), { type: 'add-writer', member });
  }

  async setRole(key: string, identity: string, role: FolderRole, name?: string): Promise<void> {
    await this.append(this.folder(key), { type: 'set-role', identity, role, ...(name ? { name } : {}) });
  }

  async removePerson(key: string, identity: string): Promise<void> {
    await this.append(this.folder(key), { type: 'remove-person', identity });
  }

  /**
   * Write a file's contents to this device's blob core and record the change. `base` is the
   * version the change was made from, null for a new file; `at` is this device's clock.
   */
  async put(key: string, path: string, data: Buffer, base: number | null, at: number): Promise<void> {
    const open = this.folder(key);
    const clean = cleanPath(path);
    if (!clean || isNeverShared(clean)) throw new Error('That path is not shared');
    if (data.byteLength > MAX_FILE_BYTES) throw new Error('That file is over 100 MB');
    this.requireWritable(open);
    const id = await open.blobs.put(data);
    await this.append(open, {
      type: 'put',
      path: clean,
      base,
      blob: { core: open.blobs.core.key.toString('hex'), ...id },
      size: data.byteLength,
      hash: crypto.hash(data).toString('hex'),
      at,
    });
  }

  async del(key: string, path: string, base: number, at: number): Promise<void> {
    const open = this.folder(key);
    this.requireWritable(open);
    await this.append(open, { type: 'del', path, base, at });
  }

  /**
   * A file's current contents, from whichever device wrote them. With `wait: false` it returns
   * null at once when no connected peer holds the blocks. Contents whose hash doesn't match the
   * view are refused.
   */
  async read(key: string, path: string, opts: { wait?: boolean } = {}): Promise<Buffer | null> {
    const file = await this.file(key, path);
    if (!file) return null;
    return this.readVersion(key, file, opts);
  }

  /** One version's contents, current or older, checked against its hash. */
  async readVersion(key: string, file: FolderFile, opts: { wait?: boolean } = {}): Promise<Buffer | null> {
    if (file.deleted || !file.blob) return null;
    const open = this.folder(key);
    const blobs = this.blobsFor(open, file.blob.core);
    const { core: _core, ...id } = file.blob;
    const data = await blobs.get(id, { wait: opts.wait ?? true });
    if (!data) return null;
    if (crypto.hash(data).toString('hex') !== file.hash) throw new Error('Contents do not match the folder');
    return data;
  }

  /**
   * Download the current version of every file that isn't on this device yet, and return how many
   * are still missing because no connected peer holds them. Replication is sparse, so a change
   * spreads only once some online device has fetched it; the mirror calls this as the view changes
   * (ADR 0049 §11).
   */
  async downloadCurrent(key: string): Promise<number> {
    let missing = 0;
    for (const file of await this.files(key)) {
      if (file.deleted || !file.blob) continue;
      if ((await this.read(key, file.path, { wait: false })) !== null) continue;
      if ((await this.read(key, file.path)) === null) missing++;
    }
    return missing;
  }

  /**
   * File changes, newest first: every version of `path`, or of every file. Each says whether its
   * order is final. Read from the view's own history, so older versions keep their authors.
   */
  async history(key: string, opts: { path?: string; limit?: number } = {}): Promise<FolderChange[]> {
    const bee = this.folder(key).base.view;
    const clean = opts.path === undefined ? null : cleanPath(opts.path);
    if (opts.path !== undefined && !clean) return [];
    const wanted = clean ? fileKey(clean) : null;
    const limit = opts.limit ?? 200;
    const signed = bee.core.signedLength;
    const out: FolderChange[] = [];
    let scanned = 0;
    for await (const entry of bee.createHistoryStream({ reverse: true })) {
      if (++scanned > HISTORY_SCAN_LIMIT) break;
      if (entry.type !== 'put') continue;
      if (wanted ? entry.key !== wanted : !entry.key.startsWith(FILES_PREFIX)) continue;
      out.push({ ...(entry.value as FolderFile), seq: entry.seq, confirmed: entry.seq < signed });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** How many file changes are in the view but not yet confirmed by enough managers. */
  async unconfirmed(key: string): Promise<number> {
    const bee = this.folder(key).base.view;
    let count = 0;
    for await (const entry of bee.createHistoryStream({ gte: bee.core.signedLength })) {
      if (entry.type === 'put' && entry.key.startsWith(FILES_PREFIX)) count++;
    }
    return count;
  }

  /** Whether this device holds a version's contents, without asking peers. */
  async hasVersion(key: string, file: FolderFile): Promise<boolean> {
    if (file.deleted || !file.blob) return false;
    return (await this.readVersion(key, file, { wait: false }).catch((): null => null)) !== null;
  }

  /** Write an older version of `path` back as a new change. */
  async restore(key: string, path: string, seq: number, at: number): Promise<void> {
    const version = (await this.history(key, { path, limit: 1000 })).find((change) => change.seq === seq);
    if (!version || version.deleted) throw new Error('That version isn’t in the file’s history.');
    const data = await this.readVersion(key, version);
    if (!data) throw new Error('That version isn’t on any Mac that’s online.');
    const current = await this.file(key, path);
    await this.put(key, current?.path ?? version.path, data, current?.version ?? null, at);
  }

  /** The two sides of a conflict copy, with their text when both are small text files. */
  async compare(key: string, copyPath: string): Promise<{ original: FolderFile; copy: FolderFile; texts: [string, string] | null }> {
    const { original, copy } = await this.conflict(key, copyPath);
    const text = async (file: FolderFile) => {
      if ((file.size ?? 0) > COMPARE_MAX_BYTES) return null;
      const data = await this.readVersion(key, file);
      if (!data) return null;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
        return decoded.includes('\u0000') ? null : decoded;
      } catch {
        return null;
      }
    };
    const [left, right] = await Promise.all([text(original), text(copy)]);
    return { original, copy, texts: left !== null && right !== null ? [left, right] : null };
  }

  /**
   * Settle a conflict copy with ordinary changes (shared folders spec, Conflicts): keep the
   * original (the copy is deleted), keep the copy (it replaces the original), or keep both (the
   * copy is written again as an ordinary file). The version not kept stays in history.
   */
  async resolve(key: string, copyPath: string, keep: 'original' | 'copy' | 'both', at: number): Promise<void> {
    const { original, copy } = await this.conflict(key, copyPath);
    if (keep === 'original') {
      await this.del(key, copy.path, copy.version, at);
      return;
    }
    const data = await this.readVersion(key, copy);
    if (!data) throw new Error('That copy isn’t on any Mac that’s online.');
    if (keep === 'both') {
      await this.put(key, copy.path, data, copy.version, at);
      return;
    }
    await this.put(key, original.path, data, original.version, at);
    await this.del(key, copy.path, copy.version, at);
  }

  private async conflict(key: string, copyPath: string): Promise<{ original: FolderFile; copy: FolderFile }> {
    const copy = await this.file(key, copyPath);
    if (!copy || copy.deleted || !copy.conflictOf) throw new Error('That conflict was already settled.');
    const original = await this.file(key, copy.conflictOf);
    if (!original) throw new Error('The file that copy was kept beside is gone.');
    return { original, copy };
  }

  /** One open folder in the shape `FolderMirror` uses. */
  forMirror(key: string): MirrorFolder {
    return {
      files: () => this.files(key),
      file: (path) => this.file(key, path),
      read: (path, opts) => this.read(key, path, opts),
      put: (path, data, base, at) => this.put(key, path, data, base, at),
      del: (path, base, at) => this.del(key, path, base, at),
      role: () => this.role(key),
    };
  }

  private blobsFor(open: OpenFolder, core: string): Hyperblobs {
    if (core === open.blobs.core.key.toString('hex')) return open.blobs;
    let blobs = this.remoteBlobs.get(core);
    if (!blobs) {
      const remote: Hypercore = this.options.store.get({
        key: Buffer.from(core, 'hex'),
        encryption: { key: Buffer.from(open.secrets.encryptionKey, 'hex') },
      });
      blobs = new Hyperblobs(remote);
      this.remoteBlobs.set(core, blobs);
    }
    return blobs;
  }

  private requireWritable(open: OpenFolder): void {
    if (!open.base.writable) throw new Error('This device can’t change that folder');
  }

  private async append(open: OpenFolder, op: FolderOp): Promise<void> {
    await open.base.append(op);
  }

  /** Wait until the view has applied what this device knows of. */
  async update(key: string): Promise<void> {
    await this.folder(key).base.update();
  }

  async close(): Promise<void> {
    for (const blobs of this.remoteBlobs.values()) await blobs.core.close().catch(() => {});
    this.remoteBlobs.clear();
    for (const open of this.folders.values()) {
      await open.blobs.core.close().catch(() => {});
      await open.base.close().catch(() => {});
    }
    this.folders.clear();
  }
}

