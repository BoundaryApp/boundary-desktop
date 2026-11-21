/**
 * Shared folders wired to the running app (ADR 0049): the manager in sharedFolderManager.ts with
 * the real Circles network, store, coding-folder rules and Trash. Main calls these; the renderer
 * reaches them through IPC.
 */

import { cp } from 'node:fs/promises';
import { shell } from 'electron';
import { APP_NAME } from '../../../shared/buildIdentity';
import type { CodingGrantRefuseReason } from '../../../shared/types/codingFolders';
import type { CirclesResult } from '../../../shared/types/circles';
import type {
  FolderScan,
  ShareFolderInput,
  SharedFolderChange,
  SharedFolderConflict,
  SharedFolderFile,
  SharedFolderListing,
  SharedFolderOnMac,
  SharedFolderProblem,
} from '../../../shared/types/sharedFolders';
import { persistDebugLog } from '../../host/log';
import { broadcast } from '../../host/windows';
import {
  deleteCircleRecord,
  folderRequest,
  getCircleRecords,
  circlesResult,
  getCirclesState,
  onCircleRecord,
  onCircleRemoved,
  onCirclesReady,
  onCirclesSnapshot,
  onSharedFolderChange,
  setCircleRecord,
} from './circlesService';
import { forgetSharedFolder, loadSharedFolders, saveSharedFolder } from './circlesStore';
import { scanFolder } from './folderScan';
import { circlesSharing } from './sharingConfig';
import type { FolderRole } from './folderOps';
import { FOLDER_JOINS_APP, FOLDER_OFFERS_APP, SharedFolderManager } from './sharedFolderManager';

function refuseMessage(reason: CodingGrantRefuseReason): string | null {
  switch (reason) {
    case 'missing':
      return null;
    case 'not-absolute':
      return 'Choose a folder by its full path.';
    case 'unsupported-characters':
      return 'Folder paths with a colon or a line break can’t be shared. Rename the folder and try again.';
    case 'root':
      return 'The whole disk can’t be shared. Choose a folder.';
    case 'home':
      return 'Your home folder is too broad to share. Choose a folder inside it.';
    case 'home-ancestor':
      return 'That folder contains your home folder. Choose a folder inside it.';
    case 'system':
      return 'System and Library folders can’t be shared.';
    case 'boundary-data':
    case 'contains-boundary-data':
      return `That folder holds ${APP_NAME}’s own data, which stays on this Mac.`;
  }
}

async function unwrap<T extends object>(result: Promise<CirclesResult<T>>): Promise<T> {
  const done = await result;
  if (done.success === false) throw new Error(done.error);
  return done;
}

const manager = new SharedFolderManager({
  request: folderRequest,
  circles: () => getCirclesState().snapshot.circles,
  identity: () => getCirclesState().snapshot.identity,
  setRecord: async (circle, app, record, value, keep) => {
    await unwrap(setCircleRecord(circle, app, 'member', record, value, { keep }));
  },
  deleteRecord: async (circle, app, record) => {
    await unwrap(deleteCircleRecord(circle, app, 'member', record));
  },
  listRecords: async (circle, app) => (await unwrap(getCircleRecords(circle, app))).records,
  load: loadSharedFolders,
  save: saveSharedFolder,
  forget: forgetSharedFolder,
  refuse: (hostPath) => {
    // The coding-folder rules (ADR 0028 §5), from the app.
    const reason = circlesSharing().folders.refuseReason(hostPath);
    return reason ? refuseMessage(reason) : null;
  },
  isGitRepo: (hostPath) => circlesSharing().folders.facts(hostPath).isGit,
  isDirectory: (hostPath) => circlesSharing().folders.facts(hostPath).isDirectory,
  copy: (from, to) => cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true }),
  moveToTrash: (hostPath) => shell.trashItem(hostPath),
  scan: (hostPath) => scanFolder(hostPath),
  log: (message, data) => persistDebugLog('circles', message, data),
});

let listening = false;

/** Start shared folders: reopen this Mac's folders whenever Circles start, and act as a manager. */
export function listenForSharedFolders(): void {
  if (listening) return;
  listening = true;
  onCircleRecord(FOLDER_JOINS_APP, (change) => manager.onJoinRecord(change));
  // A new or withdrawn offer changes a Circle's Folders list.
  onCircleRecord(FOLDER_OFFERS_APP, (change) => broadcast('circles:folder-changed', { key: change.key }));
  onSharedFolderChange((key) => {
    broadcast('circles:folder-changed', { key });
    void manager.reconcile(key);
  });
  onCircleRemoved((circle) => {
    void manager.onCircleRemoved(circle).then(() => broadcast('circles:folder-changed', { key: '' }));
  });
  onCirclesSnapshot(() => {
    for (const key of manager.localKeys()) void manager.reconcile(key);
  });
  onCirclesReady(() => {
    void manager.start().then(() => {
      for (const key of manager.localKeys()) void manager.reconcile(key);
    });
  });
}

export function listSharedFolders(circle: string): Promise<CirclesResult<{ folders: SharedFolderListing[] }>> {
  return circlesResult(async () => ({ folders: await manager.list(circle) }));
}

export function checkFolderToShare(hostPath: string): { problem: SharedFolderProblem | null } {
  return { problem: manager.checkFolder(hostPath) };
}

/** This Mac's shared folders, from Circles it left too, for the project screen. */
export function sharedFoldersOnMac(): Promise<CirclesResult<{ folders: SharedFolderOnMac[] }>> {
  return circlesResult(async () => ({ folders: await manager.onMac() }));
}

export function sharedFolderHistory(key: string, path?: string): Promise<CirclesResult<{ history: SharedFolderChange[] }>> {
  return circlesResult(async () => ({ history: await manager.history(key, path) }));
}

export function restoreSharedFolderVersion(key: string, path: string, seq: number): Promise<CirclesResult> {
  return circlesResult(async () => {
    await manager.restore(key, path, seq);
    return {};
  });
}

export function compareSharedFolderConflict(key: string, copy: string): Promise<CirclesResult<{ conflict: SharedFolderConflict }>> {
  return circlesResult(async () => ({ conflict: await manager.compare(key, copy) }));
}

export function resolveSharedFolderConflict(key: string, copy: string, keep: 'original' | 'copy' | 'both'): Promise<CirclesResult> {
  return circlesResult(async () => {
    await manager.resolve(key, copy, keep);
    return {};
  });
}

export function scanFolderToShare(hostPath: string): Promise<FolderScan> {
  return scanFolder(hostPath);
}

export function sharedFolderFiles(key: string): Promise<CirclesResult<{ files: SharedFolderFile[] }>> {
  return circlesResult(async () => ({ files: await manager.files(key) }));
}

/** Opens this Mac's copy in Finder; only a folder this Mac added, so the renderer can't name a path. */
export function revealSharedFolder(key: string): Promise<CirclesResult> {
  return circlesResult(async () => {
    const root = manager.rootOf(key);
    if (!root) throw new Error('That folder isn’t on this Mac.');
    const failed = await shell.openPath(root);
    if (failed) throw new Error(failed);
    return {};
  });
}

export function defaultSharedFolderRoot(circleName: string, folderName: string): string {
  return manager.defaultRoot(circleName, folderName);
}

export function shareFolder({ key, ...input }: ShareFolderInput): Promise<CirclesResult<{ key: string; root: string }>> {
  return circlesResult(() => manager.share(key, input));
}

export function addSharedFolder(circle: string, key: string, root: string): Promise<CirclesResult> {
  return circlesResult(async () => {
    await manager.add(circle, key, root);
    return {};
  });
}

export function removeSharedFolder(key: string, opts: { trash: boolean }): Promise<CirclesResult> {
  return circlesResult(async () => {
    await manager.remove(key, opts);
    return {};
  });
}

export function setSharedFolderRole(key: string, identity: string, role: FolderRole, name?: string): Promise<CirclesResult> {
  return circlesResult(async () => {
    await manager.setRole(key, identity, role, name);
    return {};
  });
}
