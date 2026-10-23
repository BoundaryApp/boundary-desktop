import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import type {
  CodingDeleteFolderPayload,
  CodingDeleteFolderResult,
  CodingDeleteInspect,
  CodingFoldersResult,
  CodingRemoveFolderPayload,
} from '../../../../shared/types/codingFolders';
import {
  addHermesProjectSourceFolder,
  removeHermesProjectSource,
} from '../hermes/hermesProjectSources';
import { getStoredHermesProject, listStoredHermesProjects } from '../hermes/hermesProjectStore';
import { loadSources, samePath } from '../hermes/projectSourcesModel';
import {
  codingGrantDeps,
  listCodingGrants,
  revokeCoding,
  scheduleCodingRemount,
} from './codingGrants';
import { codingGrantRefuseMessage, refuseCodingGrantReason } from './codingGrantRules';
import { findCodingGrant, removeCodingGrantRecord } from './codingGrantStore';

/**
 * Removing and deleting coding folders (ADR 0028 §10, §11). Removing never touches files.
 * Deleting moves the folder to the Trash only after the user has reviewed what's in it, and
 * only once the coding agent no longer has it mounted.
 */

export const DELETE_WALK_CAP = 100_000;

interface FolderWalk {
  files: number;
  bytes: number;
  nodeModulesBytes: number;
  lastChangedMs: number;
  truncated: boolean;
}

/** Count files and bytes without following symlinks, stopping at a cap. */
export function walkFolder(root: string, cap = DELETE_WALK_CAP): FolderWalk {
  const walk: FolderWalk = {
    files: 0,
    bytes: 0,
    nodeModulesBytes: 0,
    lastChangedMs: 0,
    truncated: false,
  };
  const stack: Array<{ dir: string; inNodeModules: boolean }> = [
    { dir: root, inNodeModules: false },
  ];
  let seen = 0;
  while (stack.length > 0) {
    const { dir, inNodeModules } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > cap) {
        walk.truncated = true;
        return walk;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ dir: full, inNodeModules: inNodeModules || entry.name === 'node_modules' });
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.lstatSync(full);
        walk.files += 1;
        walk.bytes += stat.size;
        if (inNodeModules) walk.nodeModulesBytes += stat.size;
        // .git internals change on every fetch; they don't say when the user last worked here.
        if (!full.includes(`${path.sep}.git${path.sep}`)) {
          walk.lastChangedMs = Math.max(walk.lastChangedMs, stat.mtimeMs);
        }
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return walk;
}

/** When the typed folder name is needed: anything that could lose work, or that Boundary didn't make. */
export function deleteNeedsTypedName(facts: {
  createdByBoundary: boolean;
  isGit: boolean;
  dirtyCount: number;
  unpushed: number;
  onlyStartCommit: boolean;
}): boolean {
  const nothingUnshared = facts.unpushed === 0 || facts.onlyStartCommit;
  return !(facts.createdByBoundary && facts.isGit && facts.dirtyCount === 0 && nothingUnshared);
}

function isProjectFolder(hostPath: string): boolean {
  return listStoredHermesProjects().some(
    (project) => project.kind === 'host-folder' && samePath(project.hostPath, hostPath)
  );
}

async function gitFacts(hostPath: string) {
  const deps = codingGrantDeps();
  const facts = {
    isGit: fs.existsSync(path.join(hostPath, '.git')),
    hasRemote: false,
    unpushed: 0,
    onlyStartCommit: false,
    dirtyCount: 0,
    dirtyFiles: [] as string[],
  };
  if (!facts.isGit) return facts;
  try {
    const status = await deps.gitOutput(hostPath, ['status', '--porcelain']);
    const lines = status ? status.split('\n').filter(Boolean) : [];
    facts.dirtyCount = lines.length;
    facts.dirtyFiles = lines.slice(0, 5).map((line) => line.slice(3).trim());
    facts.hasRemote = (await deps.gitOutput(hostPath, ['remote'])).length > 0;
    facts.unpushed =
      Number(
        await deps.gitOutput(hostPath, ['rev-list', '--branches', '--not', '--remotes', '--count'])
      ) || 0;
    const total = Number(await deps.gitOutput(hostPath, ['rev-list', '--all', '--count'])) || 0;
    if (total === 1) {
      const changed = await deps.gitOutput(hostPath, [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        'HEAD',
      ]);
      facts.onlyStartCommit = changed.length === 0;
    }
  } catch {
    // Unreadable repo: treat as risky so the review asks for the typed name.
    facts.unpushed = Math.max(facts.unpushed, 1);
  }
  return facts;
}

function refuseDelete(hostPath: string): string | null {
  const grant = findCodingGrant(hostPath);
  if (!grant) return 'Only folders granted to the coding agent can be deleted from Boundary.';
  if (isProjectFolder(hostPath)) return 'A project’s own folder can’t be deleted from Boundary.';
  const reason = refuseCodingGrantReason(hostPath, codingGrantDeps().ruleOptions());
  if (reason) return codingGrantRefuseMessage(reason);
  return null;
}

/** The facts the delete review leads with (ADR 0028 §11). */
export async function inspectFolderForDelete(hostPath: string): Promise<CodingDeleteInspect> {
  const resolved = path.resolve(hostPath);
  const refused = refuseDelete(resolved);
  if (refused) return { success: false, error: refused };
  const grant = findCodingGrant(resolved)!;
  const walk = walkFolder(resolved);
  const git = await gitFacts(resolved);
  const busy = await codingGrantDeps().busy();
  return {
    success: true,
    hostPath: resolved,
    name: path.basename(resolved),
    projectId: grant.projectId,
    origin: grant.origin,
    createdByBoundary: grant.createdByBoundary,
    createdAt: grant.createdAt,
    files: walk.files,
    bytes: walk.bytes,
    nodeModulesBytes: walk.nodeModulesBytes,
    lastChanged: walk.lastChangedMs ? new Date(walk.lastChangedMs).toISOString() : null,
    truncated: walk.truncated,
    ...git,
    requiresTypedName: deleteNeedsTypedName({ createdByBoundary: grant.createdByBoundary, ...git }),
    busy,
  };
}

function sourceIdFor(projectId: string, hostPath: string): string | null {
  const project = getStoredHermesProject(projectId);
  if (!project) return null;
  try {
    const spec = loadSources(project.hostPath).sources.find(
      (item) => item.path !== '.' && samePath(item.path, hostPath)
    );
    return spec?.id ?? null;
  } catch {
    return null;
  }
}

/** Drop the folder's row from every project that lists it. */
async function removeFromProjects(hostPath: string): Promise<void> {
  for (const project of listStoredHermesProjects()) {
    const sourceId = sourceIdFor(project.id, hostPath);
    if (sourceId) await removeHermesProjectSource(project.id, sourceId);
  }
}

/**
 * Remove coding access. By default the folder stays in its project as read-only reference;
 * `keep: 'none'` also drops it from the project. Files on disk are never touched.
 */
export async function removeCodingFolder(
  payload: CodingRemoveFolderPayload
): Promise<CodingFoldersResult> {
  const hostPath = path.resolve(payload.hostPath);
  const grant = findCodingGrant(hostPath);
  if (!grant) return listCodingGrants();
  const revoked = await revokeCoding({ hostPath, stopRunningTask: payload.stopRunningTask });
  if (!revoked.success) return revoked;
  if (payload.keep === 'reference' && grant.projectId && fs.existsSync(hostPath)) {
    // Adding (or re-adding) the row remounts it read-only for Hermes.
    const added = await addHermesProjectSourceFolder(grant.projectId, hostPath);
    if (!added.success && added.error) {
      return { ...listCodingGrants(), success: false, error: added.error };
    }
  } else if (payload.keep === 'none' && grant.projectId) {
    const sourceId = sourceIdFor(grant.projectId, hostPath);
    if (sourceId) await removeHermesProjectSource(grant.projectId, sourceId);
  }
  return listCodingGrants();
}

/**
 * Move a granted folder to the Trash after the user accepted the review (ADR 0028 §11):
 * remove the grant, restart the coding agent so nothing holds the mount, check no task
 * started meanwhile, then trash it. Stops at the first failure, before anything moves.
 */
export async function deleteCodingFolder(
  payload: CodingDeleteFolderPayload
): Promise<CodingDeleteFolderResult> {
  const deps = codingGrantDeps();
  const facts = await inspectFolderForDelete(payload.hostPath);
  const fail = (error: string, extra: Partial<CodingDeleteFolderResult> = {}) => ({
    ...listCodingGrants(),
    success: false,
    error,
    ...extra,
  });
  if (!facts.success || !facts.hostPath)
    return fail(facts.error ?? 'That folder can’t be deleted.');
  const hostPath = facts.hostPath;
  if (facts.requiresTypedName && payload.confirmName?.trim() !== facts.name) {
    return fail(`Type ${facts.name} to confirm.`);
  }
  if (facts.busy?.busy) {
    return fail('A coding task is running. Let it finish, then delete the folder.', {
      busy: facts.busy,
    });
  }

  removeCodingGrantRecord(hostPath);
  const outcome = await scheduleCodingRemount();
  if (!outcome.success) {
    return fail(
      `Coding access was removed, but the coding agent didn’t restart, so ${facts.name} wasn’t moved. ${
        outcome.error ?? ''
      }`.trim()
    );
  }
  const busyAgain = await deps.busy();
  if (busyAgain.busy) {
    return fail(
      `A coding task started, so ${facts.name} wasn’t moved. Try again when it finishes.`,
      {
        busy: busyAgain,
      }
    );
  }
  try {
    await deps.trash(hostPath);
  } catch (error) {
    return fail(
      `Coding access was removed, but ${facts.name} couldn’t be moved to the Trash: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  await removeFromProjects(hostPath);
  return { ...listCodingGrants(), trashed: true };
}

/** Open the Trash in Finder, where a deleted folder can be put back. */
export async function showTrash(): Promise<void> {
  await shell.openPath(path.join(os.homedir(), '.Trash'));
}
