import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialog, shell } from 'electron';
import type {
  HermesProjectSourcesInspect,
  HermesProjectSourcesResult,
  HermesSourceSpec,
} from '../../../../shared/types/hermesChat';
import { readAssistantEnvFile, resolveAssistantUserContentRoot } from '../assistantPaths';
import { isLocalAssistantStackMode } from '../localStackMode';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
import { getStoredHermesProject, listStoredHermesProjects } from './hermesProjectStore';
import {
  collectContextExtraRoots,
  listedExtraSourcePaths,
  persistContextExtraRoots,
  readCodingRoots,
  upsertHermesContextOverrideBinds,
} from './hermesContextRoots';
import { syncOverlayAndRecreate } from './hermesProjects';
import { dialogStartFolder, rememberDialogPick } from '../../dialogFolders';
import {
  buildNextStep,
  catalogIsFresh,
  loadSources,
  pathCoveredByRoots,
  refuseAddFolderReason,
  refuseMessage,
  rowsForSources,
  slugifySourceId,
  splitColonPaths,
  SOURCES_NAME,
  type MountRoots,
  writeIndex,
  writeSourcesYamlToHub,
} from './projectSourcesModel';
import { samePath } from '../../hostPaths';

function readMountRoots(): MountRoots {
  const env = readAssistantEnvFile(resolveActiveAssistantRoot());
  return {
    contextRoots: splitColonPaths(env.CONTEXT_EXTRA_ROOTS),
    codingRoots: readCodingRoots(env),
  };
}

/**
 * Recreate Hermes with the context roots the sources list now. `CONTEXT_EXTRA_ROOTS` goes
 * into the stack `.env` before the recreate, since compose reads it at `up` and Hermes's
 * instructions quote it (G09-6). An added root comes out again if the mount fails; a
 * dropped root stays out, so a failed remove isn't listed again by the next collect.
 * `undo` runs on failure too, inside the queue, before the next remount collects roots.
 */
async function remountContextRoots(options?: {
  drop?: readonly string[];
  mountLabel?: string;
  undo?: () => void;
}): Promise<{ success: boolean; error?: string }> {
  const envRoot = resolveActiveAssistantRoot();
  let previous: string[] | null = null;
  return syncOverlayAndRecreate({
    mountLabel: options?.mountLabel,
    prepare: () => {
      const roots = collectContextExtraRoots({ drop: options?.drop });
      if (isLocalAssistantStackMode()) {
        upsertHermesContextOverrideBinds(roots, envRoot);
      }
      previous = splitColonPaths(readAssistantEnvFile(envRoot).CONTEXT_EXTRA_ROOTS);
      persistContextExtraRoots(roots, envRoot);
      return roots;
    },
    rollback: options?.drop
      ? undefined
      : () => {
          options?.undo?.();
          if (previous) persistContextExtraRoots(previous, envRoot);
        },
  });
}

async function ensureExtraRootMounted(
  projectId: string,
  hostPath: string,
  undo?: () => void
): Promise<HermesProjectSourcesResult> {
  const mounts = readMountRoots();
  const codingCovered = pathCoveredByRoots(hostPath, mounts.codingRoots);
  const contextCovered = pathCoveredByRoots(hostPath, mounts.contextRoots);
  if (codingCovered) {
    return { success: true, inspect: await inspectProject(projectId) };
  }
  if (contextCovered) {
    persistContextExtraRoots(collectContextExtraRoots());
    return { success: true, inspect: await inspectProject(projectId) };
  }

  const mount = await remountContextRoots({ mountLabel: hostPath, undo });
  const inspect = await inspectProject(projectId);
  if (!mount.success) {
    return { success: false, error: mount.error, inspect };
  }
  return { success: true, inspect };
}

/**
 * Take a source the mount failed for back out of sources.yaml, so it isn't listed again
 * after a relaunch. Other edits made since stay; a file the add created goes when only the
 * hub row is left.
 */
function dropFailedSource(projectRoot: string, sourceId: string, createdFile: boolean): void {
  const remaining = loadSources(projectRoot).sources.filter((spec) => spec.id !== sourceId);
  if (createdFile && remaining.every((spec) => spec.path === '.')) {
    fs.rmSync(path.join(projectRoot, SOURCES_NAME), { force: true });
    return;
  }
  writeSourcesFile(projectRoot, remaining);
}

function libraryProjectsRoot(): string {
  return path.join(resolveAssistantUserContentRoot(resolveActiveAssistantRoot()), 'projects');
}

async function inspectProject(projectId: string): Promise<HermesProjectSourcesInspect> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    throw new Error('Project not found.');
  }
  const loaded = loadSources(project.hostPath);
  const mounts = readMountRoots();
  const sources = rowsForSources(loaded.sources, project.hostPath, mounts);
  const stale = loaded.explicit
    ? !(await catalogIsFresh(project.hostPath, loaded.sources))
    : false;
  return {
    projectId: project.id,
    stale,
    sources,
    nextStep: buildNextStep(sources, stale),
  };
}

/**
 * How many folders a project reads beyond its own, from sources.yaml alone. The Move sheet
 * needs only this; a full inspect also checks the catalog, which reads every source file.
 */
export function countHermesProjectExtraSources(projectId: string): number | null {
  const project = getStoredHermesProject(projectId);
  if (!project) return null;
  try {
    return loadSources(project.hostPath).sources.filter((spec) => spec.path !== '.').length;
  } catch {
    return null;
  }
}

export async function inspectHermesProjectSources(
  projectId: string
): Promise<HermesProjectSourcesResult> {
  try {
    return { success: true, inspect: await inspectProject(projectId) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function writeSourcesFile(projectRoot: string, sources: HermesSourceSpec[]): void {
  writeSourcesYamlToHub(projectRoot, sources);
}

export async function addHermesProjectSourceFolder(
  projectId: string,
  chosenPath?: string
): Promise<HermesProjectSourcesResult> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  let picked = chosenPath;
  if (!picked) {
    const dialogResult = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Attach a source',
      message: 'Choose a folder on this Mac — file context, not a second project',
      defaultPath: dialogStartFolder(),
    });
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    rememberDialogPick(dialogResult.filePaths[0]);
    picked = dialogResult.filePaths[0];
  }
  const hostPath = path.resolve(picked);
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    return { success: false, error: `Folder not found: ${hostPath}` };
  }

  const others = listStoredHermesProjects()
    .filter((row) => row.id !== project.id)
    .map((row) => row.hostPath);
  const reason = refuseAddFolderReason(hostPath, {
    home: os.homedir(),
    hubPath: project.hostPath,
    otherProjectHostPaths: others,
    libraryProjectsRoot: libraryProjectsRoot(),
  });
  if (reason) {
    return { success: false, error: refuseMessage(reason) };
  }

  const loaded = loadSources(project.hostPath);
  const already = loaded.sources.some(
    (spec) => spec.path !== '.' && path.resolve(spec.path) === hostPath
  );
  if (already) {
    return ensureExtraRootMounted(project.id, hostPath);
  }
  const id = slugifySourceId(path.basename(hostPath), loaded.sources.map((spec) => spec.id));
  const next: HermesSourceSpec[] = loaded.explicit
    ? [...loaded.sources]
    : [
        {
          id: 'project',
          path: '.',
          retrieval: 'files',
          include: ['**/*.md', '**/*.txt'],
          exclude: [],
        },
      ];
  if (!next.some((spec) => spec.id === 'project' && spec.path === '.')) {
    next.unshift({
      id: 'project',
      path: '.',
      retrieval: 'files',
      include: ['**/*.md', '**/*.txt'],
      exclude: [],
    });
  }
  next.push({
    id,
    path: hostPath,
    retrieval: 'files',
    include: ['**/*.md', '**/*.txt'],
    exclude: [],
  });
  try {
    writeSourcesFile(project.hostPath, next);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return ensureExtraRootMounted(project.id, hostPath, () =>
    dropFailedSource(project.hostPath, id, !loaded.explicit)
  );
}

export async function removeHermesProjectSource(
  projectId: string,
  sourceId: string
): Promise<HermesProjectSourcesResult> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  if (sourceId === 'project') {
    return { success: false, error: 'The hub source cannot be removed.' };
  }
  const loaded = loadSources(project.hostPath);
  const removed = loaded.sources.find((spec) => spec.id === sourceId);
  const next = loaded.sources.filter((spec) => spec.id !== sourceId);
  if (!removed || next.length === loaded.sources.length) {
    return { success: false, error: `Source ${sourceId} was not listed.` };
  }
  try {
    writeSourcesFile(project.hostPath, next);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const hostPath =
    removed.path === '.' || !removed.path.startsWith('/')
      ? project.hostPath
      : path.resolve(removed.path);
  const mounts = readMountRoots();
  const stillListed = listedExtraSourcePaths().some((item) => samePath(item, hostPath));
  if (stillListed || pathCoveredByRoots(hostPath, mounts.codingRoots)) {
    return { success: true, inspect: await inspectProject(project.id) };
  }

  const mount = await remountContextRoots({ drop: [hostPath], mountLabel: hostPath });
  const inspect = await inspectProject(project.id);
  if (!mount.success) {
    return { success: false, error: mount.error, inspect };
  }
  return { success: true, inspect };
}

export async function revealHermesProjectSource(
  projectId: string,
  sourceId?: string
): Promise<{ success: boolean; error?: string }> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  if (!sourceId || sourceId === 'project') {
    const error = await shell.openPath(project.hostPath);
    if (error) {
      return { success: false, error };
    }
    return { success: true };
  }
  const loaded = loadSources(project.hostPath);
  const spec = loaded.sources.find((row) => row.id === sourceId);
  if (!spec) {
    return { success: false, error: `Source ${sourceId} was not listed.` };
  }
  const hostPath =
    spec.path === '.' || !spec.path.startsWith('/')
      ? project.hostPath
      : path.resolve(spec.path);
  if (!fs.existsSync(hostPath)) {
    return { success: false, error: `Folder not found: ${hostPath}` };
  }
  const error = await shell.openPath(hostPath);
  if (error) {
    return { success: false, error };
  }
  return { success: true };
}

export async function refreshHermesProjectIndex(
  projectId: string
): Promise<HermesProjectSourcesResult> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  const loaded = loadSources(project.hostPath);
  try {
    await writeIndex(project.hostPath, loaded.sources, loaded.explicit);
    return { success: true, inspect: await inspectProject(project.id) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
