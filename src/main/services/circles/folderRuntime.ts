/**
 * The shared folders a running network process mirrors to disk (ADR 0049 §8). Main decides which
 * folders to mirror and where; this starts and stops the mirrors, keeps what each knew in a file
 * under the network's storage, and answers what main shows about a folder.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SharedFolderChange, SharedFolderSummary } from '../../../shared/types/sharedFolders';
import { FolderMirror, type MirrorKnown } from './folderMirror';
import type { FolderReply, FolderRequest } from './networkMessages';
import type { FolderChange, SharedFolders } from './sharedFolders';

/** What main shows about one shared folder on this device. */
export type FolderSummary = SharedFolderSummary;

export interface FolderRuntimeOptions {
  folders: SharedFolders;
  /** Where mirrors keep what they knew; under the network's storage directory. */
  stateDir: string;
  /** A mirror's status changed. */
  onStatus?: (key: string) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Stands in for the mirror's timing in tests. */
  mirrorTiming?: { quietMs?: number; rescanMs?: number };
}

export class FolderRuntime {
  private readonly mirrors = new Map<string, { root: string; mirror: FolderMirror }>();

  constructor(private readonly options: FolderRuntimeOptions) {}

  private stateFile(key: string): string {
    return path.join(this.options.stateDir, `${key}.json`);
  }

  /** Start mirroring an open folder into `root`; a mirror elsewhere stops first. */
  async mirror(key: string, root: string): Promise<void> {
    const current = this.mirrors.get(key);
    if (current?.root === root) return;
    if (current) await this.unmirror(key, { forget: true });
    await mkdir(this.options.stateDir, { recursive: true });
    const file = this.stateFile(key);
    const mirror = new FolderMirror({
      root,
      folder: this.options.folders.forMirror(key),
      load: async () => {
        try {
          return JSON.parse(await readFile(file, 'utf8')) as MirrorKnown;
        } catch {
          return {};
        }
      },
      save: (known) => writeFile(file, JSON.stringify(known)),
      ...this.options.mirrorTiming,
      onStatus: () => this.options.onStatus?.(key),
      log: this.options.log,
    });
    this.mirrors.set(key, { root, mirror });
    await mirror.start();
  }

  /** Stop mirroring. `forget` drops what the mirror knew, for a folder removed from this Mac. */
  async unmirror(key: string, opts: { forget?: boolean } = {}): Promise<void> {
    const current = this.mirrors.get(key);
    this.mirrors.delete(key);
    await current?.mirror.stop();
    if (opts.forget) await rm(this.stateFile(key), { force: true });
  }

  /** The folder's view changed. */
  viewChanged(key: string): void {
    void this.mirrors.get(key)?.mirror.viewChanged();
  }

  async summary(key: string): Promise<FolderSummary> {
    const { folders } = this.options;
    const live = (await folders.files(key)).filter((file) => !file.deleted);
    const current = this.mirrors.get(key);
    return {
      defaultRole: (await folders.header(key))?.role ?? null,
      people: await folders.people(key),
      writers: (await folders.writers(key)).map(({ identity, writer }) => ({ identity, writer })),
      role: await folders.role(key),
      writable: folders.writable(key),
      files: live.length,
      bytes: live.reduce((sum, file) => sum + (file.size ?? 0), 0),
      mirror: current ? { root: current.root, ...current.mirror.status() } : null,
      conflicts: live.filter((file) => file.conflictOf).map((file) => file.path),
      unconfirmed: await folders.unconfirmed(key),
    };
  }

  async close(): Promise<void> {
    for (const key of [...this.mirrors.keys()]) await this.unmirror(key);
  }
}

/** Runs one shared folder request from main against this process's folders and mirrors. */
export async function handleFolderRequest(
  folders: SharedFolders,
  runtime: FolderRuntime,
  request: FolderRequest
): Promise<FolderReply> {
  switch (request.op) {
    case 'folder-create':
      return { folder: await folders.create(request.name, request.role) };
    case 'folder-open':
      await folders.open(request.folder);
      return {};
    case 'folder-close':
      await runtime.unmirror(request.key);
      await folders.closeFolder(request.key);
      return {};
    case 'folder-intro':
      return { intro: folders.intro(request.key) };
    case 'folder-add-writer':
      await folders.addWriter(request.key, request.intro);
      return {};
    case 'folder-set-role':
      await folders.setRole(request.key, request.identity, request.role, request.name);
      return {};
    case 'folder-remove-person':
      await folders.removePerson(request.key, request.identity);
      return {};
    case 'folder-mirror':
      await runtime.mirror(request.key, request.root);
      return {};
    case 'folder-unmirror':
      await runtime.unmirror(request.key, { forget: request.forget });
      return {};
    case 'folder-summary':
      return { summary: await runtime.summary(request.key) };
    case 'folder-history': {
      const changes = await folders.history(request.key, request.path === undefined ? {} : { path: request.path });
      const history: SharedFolderChange[] = [];
      for (const change of changes) {
        const shown = asChange(change);
        // Only one file's versions say whether they're here; Activity doesn't need it.
        history.push(request.path === undefined ? shown : { ...shown, here: await folders.hasVersion(request.key, change) });
      }
      return { history };
    }
    case 'folder-restore':
      await folders.restore(request.key, request.path, request.seq, Date.now());
      return {};
    case 'folder-compare': {
      const { original, copy, texts } = await folders.compare(request.key, request.copy);
      return { conflict: { original: asChange({ ...original, seq: -1, confirmed: true }), copy: asChange({ ...copy, seq: -1, confirmed: true }), texts } };
    }
    case 'folder-resolve':
      await folders.resolve(request.key, request.copy, request.keep, Date.now());
      return {};
    case 'folder-files':
      return {
        files: (await folders.files(request.key))
          .filter((file) => !file.deleted)
          .map((file) => ({ path: file.path, size: file.size ?? 0, by: file.identity, at: file.at, conflictOf: file.conflictOf ?? null }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
  }
}

/** A view change as main and the renderer see it. */
function asChange(change: FolderChange): SharedFolderChange {
  return {
    seq: change.seq,
    path: change.path,
    version: change.version,
    deleted: change.deleted,
    size: change.size ?? 0,
    by: change.identity,
    at: change.at,
    confirmed: change.confirmed,
    conflictOf: change.conflictOf ?? null,
  };
}
