/**
 * Main's side of shared folders (ADR 0049): which folders this Mac shares or has added, the offers
 * and join requests that travel as Circle records, and what a manager's device does on its own.
 *
 * - **Offers** are kept `member` records (app `folders`, key = the folder's key) holding its name
 *   and keys (§3). Every member can read them.
 * - **Join requests** are `member` records (app `folder-joins`, key = the folder's key) holding
 *   the device's signed intro. A manager's device adds each requester whose role lets them write,
 *   and removes people who are no longer in the folder's Circle (§5, §12).
 *
 * Dependencies are passed in so this can be tested without the network process or Electron.
 */

import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from '../../../shared/buildIdentity';
import type { CircleSnapshot } from '../../../shared/types/circles';
import type {
  FolderScan,
  SharedFolderChange,
  SharedFolderConflict,
  SharedFolderFile,
  SharedFolderOnMac,
  SharedFolderListing,
  SharedFolderProblem as FolderProblem,
} from '../../../shared/types/sharedFolders';
import type { LocalSharedFolder } from './circlesStore';
import type { FolderDeviceIntro, FolderRole } from './folderOps';
import type { FolderSummary } from './folderRuntime';
import type { CircleRecordChange, FolderReply, FolderRequest } from './networkMessages';

export const FOLDER_OFFERS_APP = 'folders';
export const FOLDER_JOINS_APP = 'folder-joins';

/** An offer as it travels in a Circle record. Untrusted until `parseFolderOffer` accepts it. */
export interface FolderOffer {
  name: string;
  key: string;
  encryptionKey: string;
  /** What the sharer saw when sharing, for members deciding whether to add it. Optional. */
  role?: Exclude<FolderRole, 'manager'>;
  files?: number;
  bytes?: number;
}

export interface SharedFolderDeps {
  request(body: FolderRequest): Promise<FolderReply>;
  circles(): CircleSnapshot[];
  /** This user's identity key. */
  identity(): string;
  setRecord(circle: string, app: string, record: string, value: unknown, keep: boolean): Promise<void>;
  deleteRecord(circle: string, app: string, record: string): Promise<void>;
  listRecords(circle: string, app: string): Promise<Array<{ identity: string | null; key: string; value: unknown }>>;
  load(): Promise<LocalSharedFolder[]>;
  save(folder: LocalSharedFolder): Promise<void>;
  forget(key: string): void;
  /** Why the coding-folder rules refuse this path, in sharing's words, or null (ADR 0028 §5). A missing folder isn't refused. */
  refuse(hostPath: string): string | null;
  isGitRepo(hostPath: string): boolean;
  isDirectory(hostPath: string): boolean;
  /** Copies a folder's contents into a new folder, for sharing a copy of one inside a sync tool. */
  copy(from: string, to: string): Promise<void>;
  moveToTrash(hostPath: string): Promise<void>;
  /** What a folder holds, for the offer's file count and size. */
  scan(hostPath: string): Promise<FolderScan>;
  home?: string;
  /** Metadata only. */
  log(message: string, data?: Record<string, unknown>): void;
  /** Milliseconds since the epoch; tests pass a fixed clock. */
  now?: () => number;
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const MAX_NAME = 80;

function parseFolderOffer(value: unknown): FolderOffer | null {
  const offer = value as FolderOffer;
  if (typeof offer !== 'object' || offer === null) return null;
  if (typeof offer.name !== 'string' || !offer.name.trim() || offer.name.length > MAX_NAME) return null;
  if (typeof offer.key !== 'string' || !HEX_KEY.test(offer.key)) return null;
  if (typeof offer.encryptionKey !== 'string' || !HEX_KEY.test(offer.encryptionKey)) return null;
  return { name: offer.name.trim(), key: offer.key, encryptionKey: offer.encryptionKey };
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The facts an offer carries, when all of them are there and make sense. */
function offerFacts(value: unknown): SharedFolderListing['offered'] {
  const offer = value as FolderOffer;
  if (offer.role !== 'editor' && offer.role !== 'reader') return null;
  if (!isCount(offer.files) || !isCount(offer.bytes)) return null;
  return { role: offer.role, files: offer.files, bytes: offer.bytes };
}

function parseIntro(value: unknown): FolderDeviceIntro | null {
  const intro = value as FolderDeviceIntro;
  if (typeof intro !== 'object' || intro === null) return null;
  const keys = [intro.identity, intro.device, intro.writer, intro.blobs];
  if (!keys.every((key) => typeof key === 'string' && HEX_KEY.test(key))) return null;
  if (typeof intro.signature !== 'string' || !/^[0-9a-f]{128}$/.test(intro.signature)) return null;
  if (typeof intro.name !== 'string' || !intro.name.trim() || intro.name.length > MAX_NAME) return null;
  return intro;
}

/** A name as one folder level: no slashes or colons, and not empty. */
function asFolderName(name: string): string {
  return name.replace(/[/:\\]/g, ' ').replace(/^\.+/, '').trim().slice(0, MAX_NAME) || 'Shared folder';
}

/** Sync tools whose folders a shared folder must not sit inside, by where macOS keeps them. */
function syncToolFor(hostPath: string, home: string): string | null {
  const inside = (dir: string) => hostPath === dir || hostPath.startsWith(`${dir}${path.sep}`);
  if (inside(path.join(home, 'Library', 'Mobile Documents'))) return 'iCloud Drive';
  const cloud = path.join(home, 'Library', 'CloudStorage');
  if (inside(cloud)) {
    const provider = hostPath.slice(cloud.length + 1).split(path.sep)[0] ?? '';
    if (provider.startsWith('GoogleDrive')) return 'Google Drive';
    if (provider.startsWith('OneDrive')) return 'OneDrive';
    if (provider.startsWith('Dropbox')) return 'Dropbox';
    return 'a cloud storage app';
  }
  if (inside(path.join(home, 'Dropbox'))) return 'Dropbox';
  if (inside(path.join(home, 'Google Drive'))) return 'Google Drive';
  return null;
}

export class SharedFolderManager {
  private local = new Map<string, LocalSharedFolder>();
  /** Folders whose Circle this Mac left: kept so their projects can say they no longer sync. */
  private ended = new Map<string, LocalSharedFolder>();
  /** Join requests seen, by folder key and identity. */
  private readonly joins = new Map<string, Map<string, FolderDeviceIntro>>();
  /** Folders being reconciled, so overlapping changes don't append the same operation twice. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: SharedFolderDeps) {}

  private get home(): string {
    return this.deps.home ?? os.homedir();
  }

  /** Where a folder added from `circle` lives by default: `~/Circles/<Circle>/<folder>`. */
  defaultRoot(circleName: string, folderName: string): string {
    return path.join(this.home, 'Circles', asFolderName(circleName), asFolderName(folderName));
  }

  /** Why `hostPath` can't be shared as it is, or null. Checked before the share sheet's People step. */
  checkFolder(hostPath: string): FolderProblem | null {
    const tool = syncToolFor(path.resolve(hostPath), this.home);
    if (tool) {
      return {
        kind: 'sync-tool',
        tool,
        message: `This folder is in ${tool}. ${tool} and ${APP_NAME} would both sync it and overwrite each other’s changes. ${APP_NAME} can share a copy instead.`,
      };
    }
    const refused = this.deps.refuse(hostPath);
    if (refused) return { kind: 'refused', message: refused };
    if (this.deps.isGitRepo(hostPath)) {
      return {
        kind: 'git',
        message: 'This folder is a git repository. Shared folders sync whole files, so each Mac’s repository would drift apart. Share code through git instead.',
      };
    }
    return null;
  }

  /** Open every folder this Mac has added and start mirroring it. Call when Circles are ready. */
  async start(): Promise<void> {
    const stored = await this.deps.load();
    this.local = new Map(stored.filter((folder) => !folder.ended).map((folder) => [folder.secrets.key, folder]));
    this.ended = new Map(stored.filter((folder) => folder.ended).map((folder) => [folder.secrets.key, folder]));
    for (const folder of this.local.values()) {
      try {
        await this.deps.request({ op: 'folder-open', folder: folder.secrets });
        await this.deps.request({ op: 'folder-mirror', key: folder.secrets.key, root: folder.root });
      } catch (error) {
        this.deps.log('shared folder failed to open', { folder: folder.secrets.key.slice(0, 12), error: errorName(error) });
      }
    }
  }

  /**
   * Share a folder with a Circle: `source` is a folder on this Mac, or null to start an empty one
   * in `~/Circles/<Circle>/`. `copy` shares a copy of `source`, for one inside a sync tool.
   */
  async share(
    circle: string,
    input: {
      name: string;
      source: string | null;
      copy?: boolean;
      role: Exclude<FolderRole, 'manager'>;
      managers?: Array<{ identity: string; name: string }>;
    }
  ): Promise<{ key: string; root: string }> {
    const circleName = this.circleName(circle);
    let root = input.source ? path.resolve(input.source) : this.defaultRoot(circleName, input.name);
    if (input.source) {
      if (!this.deps.isDirectory(root)) throw new Error('That folder doesn’t exist.');
      const problem = this.checkFolder(root);
      if (problem && !(problem.kind === 'sync-tool' && input.copy)) throw new Error(problem.message);
      if (input.copy) {
        const target = this.defaultRoot(circleName, input.name);
        await this.deps.copy(root, target);
        root = target;
      }
    }
    const { folder } = await this.deps.request({ op: 'folder-create', name: asFolderName(input.name), role: input.role });
    if (!folder) throw new Error('The folder wasn’t created.');
    const local: LocalSharedFolder = { circle, circleName, name: asFolderName(input.name), secrets: folder, root };
    await this.deps.save(local);
    this.local.set(folder.key, local);
    await this.deps.request({ op: 'folder-mirror', key: folder.key, root });
    // Managers chosen on the share sheet, from the Circle's members (§5).
    const members = new Set(this.deps.circles().find((c) => c.key === circle)?.members.map((m) => m.identity) ?? []);
    for (const manager of input.managers ?? []) {
      if (manager.identity === this.deps.identity() || !members.has(manager.identity)) continue;
      await this.deps.request({ op: 'folder-set-role', key: folder.key, identity: manager.identity, role: 'manager', name: manager.name });
    }
    const scan = input.source ? await this.deps.scan(root) : { files: 0, bytes: 0 };
    const offer: FolderOffer = {
      name: local.name,
      key: folder.key,
      encryptionKey: folder.encryptionKey,
      role: input.role,
      files: scan.files,
      bytes: scan.bytes,
    };
    await this.deps.setRecord(circle, FOLDER_OFFERS_APP, folder.key, offer, true);
    return { key: folder.key, root };
  }

  /** The folders offered in a Circle, with what this Mac has of each. */
  async list(circle: string): Promise<SharedFolderListing[]> {
    const out: SharedFolderListing[] = [];
    for (const record of await this.deps.listRecords(circle, FOLDER_OFFERS_APP)) {
      const offer = parseFolderOffer(record.value);
      if (!offer || offer.key !== record.key || !record.identity) continue;
      const local = this.local.get(offer.key);
      let summary: FolderSummary | null = null;
      if (local) summary = (await this.deps.request({ op: 'folder-summary', key: offer.key }).catch((): FolderReply => ({}))).summary ?? null;
      out.push({
        circle,
        key: offer.key,
        name: offer.name,
        by: record.identity,
        offered: offerFacts(record.value),
        local: local ? { root: local.root, summary } : null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Add an offered folder to this Mac at `root`, and ask its managers to let this device write. */
  async add(circle: string, key: string, root: string): Promise<void> {
    if (this.local.has(key)) throw new Error('That folder is already on this Mac.');
    const record = (await this.deps.listRecords(circle, FOLDER_OFFERS_APP)).find((r) => r.key === key);
    const offer = record ? parseFolderOffer(record.value) : null;
    if (!offer || offer.key !== key) throw new Error('That folder isn’t shared in this Circle any more.');
    const resolved = path.resolve(root);
    const problem = this.checkFolder(resolved);
    if (problem) throw new Error(problem.message);
    const local: LocalSharedFolder = {
      circle,
      circleName: this.circleName(circle),
      name: offer.name,
      secrets: { key, encryptionKey: offer.encryptionKey, namespace: randomNamespace() },
      root: resolved,
    };
    await this.deps.request({ op: 'folder-open', folder: local.secrets });
    await this.deps.save(local);
    this.local.set(key, local);
    this.ended.delete(key);
    await this.deps.request({ op: 'folder-mirror', key, root: resolved });
    const { intro } = await this.deps.request({ op: 'folder-intro', key });
    if (intro) await this.deps.setRecord(circle, FOLDER_JOINS_APP, key, intro, false);
  }

  /** Stop syncing a folder here. Its files stay unless `trash` moves them to the Trash (§12). */
  async remove(key: string, opts: { trash: boolean }): Promise<void> {
    const ended = this.ended.get(key);
    if (ended) {
      // A folder from a Circle this Mac left: only the record goes, unless asked for the files.
      this.ended.delete(key);
      this.deps.forget(key);
      if (opts.trash) await this.deps.moveToTrash(ended.root);
      return;
    }
    const local = this.local.get(key);
    if (!local) return;
    await this.deps.request({ op: 'folder-unmirror', key, forget: true });
    await this.deps.request({ op: 'folder-close', key });
    this.local.delete(key);
    this.deps.forget(key);
    await this.deps.deleteRecord(local.circle, FOLDER_JOINS_APP, key).catch(() => {});
    if (opts.trash) await this.deps.moveToTrash(local.root);
  }

  /**
   * This Mac left or was removed from a Circle (ADR 0049 §12): its folders stop syncing here and
   * their files stay. Each is kept marked as ended, so its project can say it's no longer shared.
   * The Circle is closed, so join requests can't be withdrawn and aren't tried.
   */
  async onCircleRemoved(circle: string): Promise<void> {
    for (const local of [...this.local.values()].filter((folder) => folder.circle === circle)) {
      const key = local.secrets.key;
      try {
        await this.deps.request({ op: 'folder-unmirror', key, forget: true });
        await this.deps.request({ op: 'folder-close', key });
      } catch (error) {
        this.deps.log('shared folder failed to close', { folder: key.slice(0, 12), error: errorName(error) });
      }
      this.local.delete(key);
      const ended: LocalSharedFolder = { ...local, ended: this.now() };
      this.ended.set(key, ended);
      await this.deps.save(ended).catch((error: unknown) => {
        this.deps.log('shared folder failed to save', { folder: key.slice(0, 12), error: errorName(error) });
      });
    }
  }

  /** Every shared folder on this Mac, those from Circles it left included, for the project screen. */
  async onMac(): Promise<SharedFolderOnMac[]> {
    const me = this.deps.identity();
    const out: SharedFolderOnMac[] = [];
    for (const folder of [...this.local.values(), ...this.ended.values()]) {
      const key = folder.secrets.key;
      const circle = folder.ended ? undefined : this.deps.circles().find((c) => c.key === folder.circle);
      const summary = folder.ended
        ? null
        : ((await this.deps.request({ op: 'folder-summary', key }).catch((): FolderReply => ({}))).summary ?? null);
      const name = (identity: string) =>
        identity === me ? 'you' : (circle?.members.find((m) => m.identity === identity)?.name ?? summary?.people.find((p) => p.identity === identity)?.name ?? 'someone');
      out.push({
        key,
        circle: folder.circle,
        circleName: circle?.name ?? folder.circleName ?? 'a Circle',
        name: folder.name,
        root: folder.root,
        role: summary?.role ?? null,
        defaultRole: summary?.defaultRole ?? null,
        people: summary?.people.length ?? 0,
        managers: (summary?.people ?? []).filter((p) => p.role === 'manager').map((p) => name(p.identity)),
        ended: folder.ended ?? null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async setRole(key: string, identity: string, role: FolderRole, name?: string): Promise<void> {
    await this.deps.request({ op: 'folder-set-role', key, identity, role, ...(name ? { name } : {}) });
  }

  /** A join record changed in some Circle. */
  onJoinRecord(change: CircleRecordChange): void {
    if (!change.identity) return;
    const byFolder = this.joins.get(change.key) ?? new Map<string, FolderDeviceIntro>();
    this.joins.set(change.key, byFolder);
    const intro = change.deleted ? null : parseIntro(change.value);
    // A request only counts from the person it names.
    if (intro && intro.identity === change.identity) byFolder.set(change.identity, intro);
    else byFolder.delete(change.identity);
    void this.reconcile(change.key);
  }

  /** A folder's view changed, or a Circle's members did: act on it if this device manages it. */
  async reconcile(key: string): Promise<void> {
    const local = this.local.get(key);
    if (!local || this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const { summary } = await this.deps.request({ op: 'folder-summary', key });
      if (!summary || summary.role !== 'manager') return;
      const members = new Set(this.deps.circles().find((c) => c.key === local.circle)?.members.map((m) => m.identity) ?? []);
      if (members.size === 0) return;
      const me = this.deps.identity();
      // People who left the Circle leave the folder (§12).
      for (const person of summary.people) {
        if (person.identity !== me && !members.has(person.identity)) {
          await this.deps.request({ op: 'folder-remove-person', key, identity: person.identity });
        }
      }
      // Requests from members whose role lets them write, and whose device isn't a writer yet.
      const writers = new Set(summary.writers.map((w) => w.writer));
      const roles = new Map(summary.people.map((p) => [p.identity, p.role]));
      const defaultRole = summary.defaultRole ?? 'reader';
      for (const [identity, intro] of this.joins.get(key) ?? []) {
        if (!members.has(identity) || writers.has(intro.writer)) continue;
        if ((roles.get(identity) ?? defaultRole) === 'reader') continue;
        await this.deps.request({ op: 'folder-add-writer', key, intro });
      }
    } catch (error) {
      this.deps.log('shared folder reconcile failed', { folder: key.slice(0, 12), error: errorName(error) });
    } finally {
      this.busy.delete(key);
    }
  }

  /** The files in a folder this Mac has added. */
  async files(key: string): Promise<SharedFolderFile[]> {
    this.requireLocal(key);
    return (await this.deps.request({ op: 'folder-files', key })).files ?? [];
  }

  /** File changes newest first: one file's versions, or every file's for Activity. */
  async history(key: string, path?: string): Promise<SharedFolderChange[]> {
    this.requireLocal(key);
    return (await this.deps.request({ op: 'folder-history', key, ...(path === undefined ? {} : { path }) })).history ?? [];
  }

  async restore(key: string, path: string, seq: number): Promise<void> {
    this.requireLocal(key);
    await this.deps.request({ op: 'folder-restore', key, path, seq });
  }

  async compare(key: string, copy: string): Promise<SharedFolderConflict> {
    this.requireLocal(key);
    const { conflict } = await this.deps.request({ op: 'folder-compare', key, copy });
    if (!conflict) throw new Error('That conflict was already settled.');
    return conflict;
  }

  async resolve(key: string, copy: string, keep: 'original' | 'copy' | 'both'): Promise<void> {
    this.requireLocal(key);
    await this.deps.request({ op: 'folder-resolve', key, copy, keep });
  }

  private requireLocal(key: string): void {
    if (!this.local.has(key)) throw new Error('That folder isn’t on this Mac.');
  }

  /** Where this Mac keeps a folder, or null when it hasn't added it. */
  rootOf(key: string): string | null {
    return (this.local.get(key) ?? this.ended.get(key))?.root ?? null;
  }

  /** Every folder this Mac has, for checks after a Circle's members change. */
  localKeys(): string[] {
    return [...this.local.keys()];
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private circleName(circle: string): string {
    const found = this.deps.circles().find((c) => c.key === circle);
    if (!found) throw new Error('That Circle isn’t open on this Mac.');
    return found.name;
  }
}

const randomNamespace = (): string => randomBytes(16).toString('hex');

const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
