import { useCallback, useEffect, useState } from 'react';
import type { SharedFolderOnMac } from '../../../shared/types/sharedFolders';
import { folderKey } from './codingFolderView';

/**
 * Shared folders as This Mac's projects see them (shared folders spec, Flows: On This Mac): which
 * project folder is shared, with whom, and what that means for what's written there. Pure apart
 * from the hook, so every wording is tested without IPC.
 */

/** The shared folder at `hostPath`, if this Mac has one there. */
export function sharedFolderAt(hostPath: string, folders: readonly SharedFolderOnMac[]): SharedFolderOnMac | null {
  const key = folderKey(hostPath);
  return folders.find((folder) => folderKey(folder.root) === key) ?? null;
}

/** The shared folders a project works in: its own folder, or one inside it. */
export function sharedFoldersIn(projectPath: string, folders: readonly SharedFolderOnMac[]): SharedFolderOnMac[] {
  const key = folderKey(projectPath);
  return folders.filter((folder) => {
    const root = folderKey(folder.root);
    return root === key || root.startsWith(`${key}/`);
  });
}

const sameDay = (at: number) => new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' });

function managerLine(managers: string[]): string {
  if (managers.length === 0) return 'Its managers';
  if (managers.length === 1) return managers[0] === 'you' ? 'You' : managers[0];
  return `${managers.slice(0, -1).join(', ')} and ${managers[managers.length - 1]}`;
}

/** The Folders row's tag and the line under it. `coding` is whether the coding agent may edit here. */
export function sharedRowView(folder: SharedFolderOnMac, coding: boolean): { tag: string; line: string } {
  if (folder.ended !== null) {
    return {
      tag: 'No longer shared',
      line: `You left ${folder.circleName} on ${sameDay(folder.ended)}. Nothing syncs now; the files stay here.`,
    };
  }
  const tag = `Shared · ${folder.circleName}`;
  if (folder.role === null) return { tag, line: `Shared with ${folder.circleName}. Connecting…` };
  if (folder.role === 'reader') {
    const who = managerLine(folder.managers);
    return {
      tag,
      line: `${who} ${folder.managers.length > 1 ? 'manage' : 'manages'} it. Hermes can read it; changes made here stay on this Mac.`,
    };
  }
  const reach =
    folder.people > 1
      ? `goes to all ${folder.people} people in it`
      : `goes to everyone in ${folder.circleName} who adds it`;
  const everyone = folder.defaultRole === 'editor' ? `Everyone in ${folder.circleName} can edit. ` : '';
  const agent = coding ? ' The coding agent’s changes sync too.' : ' If you allow coding, the coding agent’s changes sync too.';
  return { tag, line: `${everyone}Anything you or Hermes writes here ${reach}.${agent}` };
}

/** The composer's line for a chat whose project holds a shared folder this person can change. */
export function composerSharedHint(folders: readonly SharedFolderOnMac[]): string | null {
  const live = folders.filter((folder) => folder.ended === null && folder.role !== null && folder.role !== 'reader');
  if (live.length === 0) return null;
  if (live.length === 1) return `Files written in ${live[0].name} reach ${live[0].circleName}.`;
  return `Files written in ${live.map((folder) => folder.name).join(', ')} reach their Circles.`;
}

/** This Mac's shared folders, reloaded whenever main says a folder changed. */
export function useSharedFoldersOnMac(): SharedFolderOnMac[] {
  const [folders, setFolders] = useState<SharedFolderOnMac[]>([]);
  const load = useCallback(async () => {
    const result = await window.electronAPI.circles.foldersOnMac();
    if (result.success !== false) setFolders(result.folders);
  }, []);
  useEffect(() => {
    void load();
    return window.electronAPI.circles.onFolderChanged(() => void load());
  }, [load]);
  return folders;
}
