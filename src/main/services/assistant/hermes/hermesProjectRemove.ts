import path from 'node:path';
import { shell } from 'electron';
import type {
  HermesProjectRecord,
  HermesProjectRemoveInspect,
  HermesProjectRemovePayload,
  HermesProjectRemoveResult,
} from '../../../../shared/types/hermesChat';
import { getStackFiles } from '../../stackHost/activeStack';
import { getProjectEnv } from '../AssistantStackService';
import { hasStackCapability } from '../../stackHost/capabilities';
import { deleteNeedsTypedName, gitFacts, walkFolder } from '../coding/codingFolderActions';
import { folderFacts } from '../coding/codingGrantRules';
import { readStackEnv } from '../stackEnv';
import { auditCodingChange, codingFoldersBusy } from '../coding/codingGrants';
import {
  collectContextExtraRoots,
  listedExtraSourcePaths,
  persistContextExtraRoots,
} from './hermesContextRoots';
import { getHermesGatewaySession } from './hermesGatewaySession';
import { listResult, projectTurnRunning, syncOverlayAndRecreate } from './hermesProjects';
import {
  getActiveHermesProjectId,
  getStoredHermesProject,
  removeStoredHermesProject,
  setActiveHermesProjectId,
  upsertStoredHermesProject,
} from './hermesProjectStore';
import { splitColonPaths } from './projectSourcesModel';
import { samePath } from '../../hostPaths';

/** Removing a project (ADR 0067). */

const TURN_RUNNING_REFUSAL =
  'A reply in this project is still running. Remove it when the reply finishes.';

/** A remote host's folders are on the other machine, out of reach of the Trash (§8). */
export const REMOTE_HOST_REFUSAL =
  'Removing a project isn’t available while your agent runs on another computer.';

interface ProjectRemoveDeps {
  trash: (hostPath: string) => Promise<void>;
}

const defaultDeps: ProjectRemoveDeps = {
  trash: (hostPath) => shell.trashItem(hostPath),
};

let deps: ProjectRemoveDeps = defaultDeps;

export function setProjectRemoveDepsForTests(next: Partial<ProjectRemoveDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

/** Why the project can't be removed now, or null. */
function refusalFor(project: HermesProjectRecord): string | null {
  if (!hasStackCapability('hostFolders')) return REMOTE_HOST_REFUSAL;
  if (projectTurnRunning(project.id)) return TURN_RUNNING_REFUSAL;
  return null;
}

/** Whether removing a Boundary-made project asks for its typed name (§3). */
async function madeProjectTypedName(project: HermesProjectRecord) {
  const git = await gitFacts(project.hostPath);
  return { git, requiresTypedName: deleteNeedsTypedName({ createdByBoundary: true, ...git }) };
}

function warn(message: string, error?: unknown): void {
  if (error === undefined) {
    console.warn(`[projects] remove: ${message}`);
    return;
  }
  console.warn(`[projects] remove: ${message}`, error instanceof Error ? error.message : String(error));
}

function fail(error: string, extra: Partial<HermesProjectRemoveResult> = {}): HermesProjectRemoveResult {
  return { ...listResult(), success: false, error, ...extra };
}

/**
 * Clear the gateway's active project when it was this one, then delete its database row.
 * Neither failure fails the removal: the stack leaves out a row whose folder is gone (§2.5).
 */
async function forgetOnGateway(project: HermesProjectRecord, wasActive: boolean): Promise<void> {
  let gateway: ReturnType<typeof getHermesGatewaySession>;
  try {
    gateway = getHermesGatewaySession();
    await gateway.ensureConnected();
  } catch (error) {
    warn('gateway not reachable, skipped projects.delete:', error);
    return;
  }
  if (wasActive) {
    try {
      await gateway.setActiveProject(null);
    } catch (error) {
      warn('projects.set_active failed:', error);
    }
  }
  const id = project.hermesProjectId;
  if (id && !id.startsWith('fs:')) {
    try {
      await gateway.deleteProject(id);
    } catch (error) {
      warn('projects.delete failed:', error);
    }
  }
}

/** The placeholder `projects/<slug>` a folder project's bind used, or null for an odd slug. */
function placeholderPath(project: HermesProjectRecord): string | null {
  const slug = project.containerPath.replace(/^\/opt\/projects\//, '');
  if (!slug || slug.includes('/') || slug === '..' || slug === '.') return null;
  return `projects/${slug}`;
}

/** Files Finder and macOS write into any folder the user opens; they don't make it hold anything. */
function isFinderFile(name: string): boolean {
  return name === '.DS_Store' || name === '.localized' || name.startsWith('._');
}

/**
 * Delete the empty mount point; leave one that has anything in it (§2.4). A placeholder left
 * behind is listed by the stack and comes back as a Boundary-made project, so Finder's own
 * files don't count.
 */
async function removePlaceholder(project: HermesProjectRecord): Promise<void> {
  const rel = placeholderPath(project);
  if (!rel) return;
  const files = getStackFiles();
  try {
    const entries = await files.list('userContent', rel);
    if (entries === null) return;
    if (entries.some((name) => !isFinderFile(name))) {
      warn(`placeholder not empty, left ${path.basename(rel)}`);
      return;
    }
    await files.remove('userContent', rel);
  } catch (error) {
    warn(`placeholder ${path.basename(rel)} not removed:`, error);
  }
}

async function removeFolderProject(
  project: HermesProjectRecord,
  payload: HermesProjectRemovePayload
): Promise<HermesProjectRemoveResult> {
  const coding = Boolean(project.codingEnabled);
  if (coding) {
    const busy = await codingFoldersBusy();
    if (busy.busy && !payload.stopRunningTask) {
      return fail('A coding task is running.', { busy });
    }
  }

  const drop = listedExtraSourcePaths([project]);
  const files = getStackFiles();
  let saved: HermesProjectRecord | null = null;
  let wasActive = false;
  let previousRoots: string[] | null = null;
  const mount = await syncOverlayAndRecreate({
    mountLabel: project.hostPath,
    // Dropping the record drops the folder from the coding mounts, so coding goes off in
    // this restart (§2.1).
    codingAgent: coding,
    prepare: async () => {
      saved = getStoredHermesProject(project.id);
      if (!saved) throw new Error('Project not found.');
      wasActive = getActiveHermesProjectId() === project.id;
      previousRoots = splitColonPaths((await readStackEnv(files, 'stack', '.env')).CONTEXT_EXTRA_ROOTS);
      removeStoredHermesProject(project.id);
      if (wasActive) setActiveHermesProjectId(null);
      // A folder another project still lists keeps its mount.
      const stillListed = listedExtraSourcePaths();
      const ownOnly = drop.filter((item) => !stillListed.some((other) => samePath(other, item)));
      const roots = await collectContextExtraRoots({ drop: ownOnly, files });
      await persistContextExtraRoots(roots, getProjectEnv());
      return roots;
    },
    rollback: async () => {
      if (saved) upsertStoredHermesProject(saved);
      if (wasActive) setActiveHermesProjectId(project.id);
      if (previousRoots) await persistContextExtraRoots(previousRoots, getProjectEnv());
    },
  });
  if (coding) {
    auditCodingChange(
      'coding_revoke',
      { path: path.resolve(project.hostPath), projectId: project.id },
      'removed',
      mount.success ? undefined : (mount.error ?? 'failed')
    );
  }
  if (!mount.success) return fail(mount.error ?? 'Hermes didn’t restart.');

  await removePlaceholder(project);
  await forgetOnGateway(project, wasActive);
  return { ...listResult(), removed: true };
}

/**
 * Move a Boundary-made project's folder to the Trash, then forget it (§3). The folder sits
 * inside the `projects` bind, so Hermes doesn't restart. A failed move changes nothing.
 */
async function removeMadeProject(
  project: HermesProjectRecord,
  payload: HermesProjectRemovePayload
): Promise<HermesProjectRemoveResult> {
  // A folder that's already gone has nothing to lose or move; the record is all that's left.
  const folderGone = !folderFacts(project.hostPath).isDirectory;
  if (folderGone) {
    warn(`folder already gone, forgetting ${project.slug}`);
  } else {
    // Recomputed here rather than trusted from the sheet.
    const { requiresTypedName } = await madeProjectTypedName(project);
    if (requiresTypedName && payload.confirmName?.trim() !== project.name) {
      return fail(`Type ${project.name} to confirm.`);
    }
    try {
      await deps.trash(project.hostPath);
    } catch (error) {
      return fail(
        `${project.name} couldn’t be moved to the Trash: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  const wasActive = getActiveHermesProjectId() === project.id;
  removeStoredHermesProject(project.id);
  if (wasActive) setActiveHermesProjectId(null);
  await forgetOnGateway(project, wasActive);
  return { ...listResult(), removed: true, trashed: !folderGone };
}

/** Remove a project from Boundary and the stack (ADR 0067). */
export async function removeHermesProject(
  payload: HermesProjectRemovePayload
): Promise<HermesProjectRemoveResult> {
  const project = getStoredHermesProject(payload.projectId);
  if (!project) return fail('Project not found.');
  const refusal = refusalFor(project);
  if (refusal) return fail(refusal);
  if (project.kind === 'empty') return removeMadeProject(project, payload);
  return removeFolderProject(project, payload);
}

/** What the Remove project sheet shows: the refusal, and for a Boundary-made project what would be lost. */
export async function inspectHermesProjectForRemove(
  projectId: string
): Promise<HermesProjectRemoveInspect> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return {
      success: false,
      error: 'Project not found.',
      projectId,
      name: '',
      kind: 'host-folder',
      hostPath: '',
      requiresTypedName: false,
    };
  }
  const base = {
    success: true,
    projectId: project.id,
    name: project.name,
    kind: project.kind,
    hostPath: project.hostPath,
    refusal: refusalFor(project) ?? undefined,
  };
  if (project.kind !== 'empty') return { ...base, requiresTypedName: false };
  const [walk, typed] = await Promise.all([
    walkFolder(project.hostPath),
    madeProjectTypedName(project),
  ]);
  const { git, requiresTypedName } = typed;
  return {
    ...base,
    files: walk.files,
    bytes: walk.bytes,
    lastChanged: walk.lastChangedMs ? new Date(walk.lastChangedMs).toISOString() : null,
    truncated: walk.truncated,
    isGit: git.isGit,
    unpushed: git.unpushed,
    onlyStartCommit: git.onlyStartCommit,
    dirtyCount: git.dirtyCount,
    // Matches removeMadeProject: a folder that's already gone has nothing to confirm.
    requiresTypedName: requiresTypedName && folderFacts(project.hostPath).isDirectory,
  };
}
