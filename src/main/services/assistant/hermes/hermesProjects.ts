import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, shell } from 'electron';
import type {
  ChatInferenceProvider,
  HermesCompletePathPayload,
  HermesCompletePathResult,
  HermesProjectChangeFolderPayload,
  HermesProjectCreateEmptyPayload,
  HermesProjectCreateHostPayload,
  HermesProjectPatchPayload,
  HermesProjectRecord,
  HermesProjectResult,
  HermesProjectSelectPayload,
  HermesProjectsListResult,
  ProjectInferencePin,
} from '../../../../shared/types/hermesChat';
import type { FirstRunFolder } from '../../../../shared/types/setupProgress';
import { getSlotLlmConnection, keepChainFallbacks } from '../../onboarding/OpenAiOnboardingStore';
import { recreateHermesForProjectMounts } from '../AssistantStackService';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
import { isLocalAssistantStackMode } from '../localStackMode';
import { getHermesGatewaySession } from './hermesGatewaySession';
import {
  getActiveHermesProjectId,
  getStoredHermesProject,
  listStoredHermesProjects,
  removeStoredHermesProject,
  replaceStoredHermesProjects,
  setActiveHermesProjectId,
  upsertStoredHermesProject,
} from './hermesProjectStore';
import {
  containerPathForSlug,
  defaultProjectNameFromHostPath,
  ensureProjectMountPoints,
  uniqueProjectSlug,
  writeHermesProjectsOverlay,
} from './hermesProjectsOverlay';
import { syncProjectsFromGateway, type HermesProjectsListPayload } from './hermesProjectsMerge';
import {
  areProjectFoldersMounted,
  enqueueFolderRemount,
  recordMountedProjectFolders,
} from './projectMountState';
import { samePath } from '../../hostPaths';
import { scheduleCodingRemount } from '../coding/codingGrants';
import { persistCodingStackEnv } from '../coding/codingMounts';
import { dialogStartFolder, rememberDialogPick } from '../../dialogFolders';

let connecting = false;

function formatMountError(hostPath: string, raw: string): string {
  if (/file sharing|shared paths|virtiofs|permission denied|not allowed/i.test(raw)) {
    return (
      `Could not share ${hostPath} with the container runtime. ` +
      `Add this folder to Docker/Podman file sharing (or grant Full Disk Access), then try again. ` +
      `Files were not copied.`
    );
  }
  return raw;
}

/**
 * Boundary mounts host folders through its generated overlay, which a developer checkout's
 * compose files never read, so in local-stack mode a folder project would report success
 * without being mounted. Null when Boundary runs its own stack.
 */
function localStackHostFolderError(): string | null {
  if (!isLocalAssistantStackMode()) return null;
  return (
    'Boundary is running against a local agent stack, which doesn’t read Boundary’s project ' +
    'folder mounts, so a folder from this Mac can’t be added as a project. Create an empty ' +
    'project instead, or switch back to Boundary’s own agent stack.'
  );
}

function resolveDataRoot(): string {
  return resolveAssistantUserContentRoot(resolveActiveAssistantRoot());
}

/** The overlay from the stored projects. Only remount jobs call this, one at a time. */
function writeStoredProjectsOverlay(extraRoots?: readonly string[]): void {
  const projects = listStoredHermesProjects();
  writeHermesProjectsOverlay(projects, extraRoots);
  // Only Boundary's own stack uses the generated overlay. In local-stack mode the data
  // root is the developer checkout, so leave it alone.
  if (!isLocalAssistantStackMode()) {
    ensureProjectMountPoints(projects, path.join(resolveDataRoot(), 'projects'));
    // Project aliases follow the project list (change request 0003 R2).
    persistCodingStackEnv();
  }
}

export interface ProjectRemountOptions {
  mountLabel?: string;
  /**
   * Store or `.env` changes to make when this remount's turn starts. Returns the context
   * roots for the overlay, or nothing to collect them from the stack `.env` and sources.
   */
  prepare?: () => readonly string[] | void;
  /** Undo `prepare` when the recreate fails, so the failing bind isn't kept (G09-7). */
  rollback?: () => void;
}

function undoProjectRemount(options: ProjectRemountOptions | undefined): void {
  if (!options?.rollback) return;
  options.rollback();
  try {
    writeStoredProjectsOverlay();
  } catch {
    /* the next remount writes it again */
  }
}

async function remountProjectsNow(
  options: ProjectRemountOptions | undefined
): Promise<{ success: boolean; error?: string }> {
  let extraRoots: readonly string[] | undefined;
  try {
    extraRoots = options?.prepare?.() || undefined;
    writeStoredProjectsOverlay(extraRoots);
  } catch (error) {
    undoProjectRemount(options);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const projects = listStoredHermesProjects();
  const label =
    options?.mountLabel ??
    projects.find((p) => p.kind === 'host-folder')?.hostPath ??
    'the selected folder';
  connecting = true;
  try {
    const result = await recreateHermesForProjectMounts();
    if (!result.success) {
      undoProjectRemount(options);
      return {
        success: false,
        error: formatMountError(
          label,
          result.error ?? 'Failed to reconnect Hermes with the new folder mount.'
        ),
      };
    }
    // A local stack never gets the overlay, so its host folders aren't mounted.
    if (!isLocalAssistantStackMode()) {
      recordMountedProjectFolders(
        projects.filter((project) => project.kind === 'host-folder').map((project) => project.hostPath)
      );
    }
    return { success: true };
  } finally {
    connecting = false;
  }
}

/** Write the overlay and recreate Hermes, in the folder remount queue. */
export function syncOverlayAndRecreate(
  options?: ProjectRemountOptions
): Promise<{ success: boolean; error?: string }> {
  return enqueueFolderRemount(() => remountProjectsNow(options));
}

/** Rewrite the overlay with no recreate, after any remount that is already queued. */
function scheduleOverlayWrite(): Promise<{ success: boolean; error?: string }> {
  return enqueueFolderRemount(async () => {
    writeHermesProjectsOverlay(listStoredHermesProjects());
    return { success: true };
  });
}

/**
 * Activate a project on the gateway without inventing a DB row via projects.create.
 * Library folders use fs: ids (or materialized UUIDs); set_active materializes lazily.
 * Sessions are not touched: each chat's turn sets its own folder (ADR 0024 §2).
 */
async function activateOnGateway(
  project: HermesProjectRecord
): Promise<{ hermesProjectId?: string | null; rpcAvailable: boolean }> {
  try {
    const gateway = getHermesGatewaySession();
    await gateway.ensureConnected();
    const activateId =
      project.hermesProjectId ??
      (project.containerPath ? `fs:${project.containerPath}` : null);
    if (activateId) {
      await gateway.setActiveProject(activateId);
    }
    // Refresh id after possible materialize (fs: → UUID).
    try {
      const listed = await gateway.listProjects();
      const match =
        listed.projects.find((p) => p.id === activateId) ??
        listed.projects.find((p) => p.primaryPath === project.containerPath) ??
        listed.projects.find((p) => p.slug === project.slug);
      return {
        hermesProjectId: match?.id ?? activateId,
        rpcAvailable: true,
      };
    } catch {
      return { hermesProjectId: activateId, rpcAvailable: true };
    }
  } catch {
    return { rpcAvailable: false };
  }
}

function listResult(extra?: Partial<HermesProjectsListResult>): HermesProjectsListResult {
  return {
    success: true,
    projects: listStoredHermesProjects(),
    activeId: getActiveHermesProjectId(),
    connecting,
    rpcAvailable: extra?.rpcAvailable,
    ...extra,
  };
}

/** Same records, ignoring order: a merge that changes nothing writes nothing. */
function sameProjects(
  left: readonly HermesProjectRecord[],
  right: readonly HermesProjectRecord[]
): boolean {
  const key = (rows: readonly HermesProjectRecord[]) =>
    JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  return key(left) === key(right);
}

export async function listHermesProjects(): Promise<HermesProjectsListResult> {
  const stored = listStoredHermesProjects();
  const previousActiveId = getActiveHermesProjectId();
  const dataRoot = resolveDataRoot();

  let listed: HermesProjectsListPayload;
  try {
    const gateway = getHermesGatewaySession();
    await gateway.ensureConnected();
    listed = await gateway.listProjects();
  } catch {
    // Offline / gateway down: keep store as-is (including host-folder mounts).
    return listResult({ rpcAvailable: false });
  }
  const synced = syncProjectsFromGateway({
    stored,
    previousActiveId,
    gateway: {
      projects: listed.projects,
      activeId: listed.activeId,
    },
    dataRoot,
  });
  if (!sameProjects(stored, synced.projects)) {
    replaceStoredHermesProjects(synced.projects);
    // A failed write is the next remount's to retry; it says nothing about the gateway.
    void scheduleOverlayWrite();
  }
  if (synced.activeId !== previousActiveId) setActiveHermesProjectId(synced.activeId);
  return listResult({ rpcAvailable: true });
}

export async function pickHermesProjectFolder(): Promise<{
  success: boolean;
  hostPath?: string;
  canceled?: boolean;
  error?: string;
}> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose project folder',
    message: 'Select a folder on this Mac for the assistant to work in',
    defaultPath: dialogStartFolder(),
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  rememberDialogPick(result.filePaths[0]);
  return { success: true, hostPath: result.filePaths[0] };
}

function hostFolderRecord(
  hostPath: string,
  name?: string,
  inference?: ProjectInferencePin
): HermesProjectRecord {
  const projectName = (name?.trim() || defaultProjectNameFromHostPath(hostPath)).trim();
  const slug = uniqueProjectSlug(projectName, listStoredHermesProjects());
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: projectName,
    hostPath,
    containerPath: containerPathForSlug(slug),
    slug,
    kind: 'host-folder',
    hermesProjectId: `fs:${containerPathForSlug(slug)}`,
    inference: inference ?? { mode: 'inherit' },
    createdAt: now,
    updatedAt: now,
  };
}

export async function createHostFolderHermesProject(
  payload: HermesProjectCreateHostPayload
): Promise<HermesProjectResult> {
  const localStackError = localStackHostFolderError();
  if (localStackError) return { success: false, error: localStackError };

  const hostPath = path.resolve(payload.hostPath);
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    return { success: false, error: `Folder not found: ${hostPath}` };
  }

  // The record is made when the remount's turn starts, so its slug sees projects saved by
  // remounts queued ahead of it.
  let project: HermesProjectRecord | null = null;
  let previousActiveId: string | null = null;
  const mount = await syncOverlayAndRecreate({
    mountLabel: hostPath,
    prepare: () => {
      previousActiveId = getActiveHermesProjectId();
      project = hostFolderRecord(hostPath, payload.name, payload.inference);
      upsertStoredHermesProject(project);
      setActiveHermesProjectId(project.id);
    },
    rollback: () => {
      if (!project) return;
      removeStoredHermesProject(project.id);
      if (getActiveHermesProjectId() === project.id) setActiveHermesProjectId(previousActiveId);
    },
  });
  if (!mount.success || !project) {
    return {
      success: false,
      error: mount.error,
      projects: listStoredHermesProjects(),
      activeId: getActiveHermesProjectId(),
      connecting: false,
    };
  }

  const rpc = await activateOnGateway(project);
  if (rpc.hermesProjectId) {
    project.hermesProjectId = rpc.hermesProjectId;
    project.updatedAt = new Date().toISOString();
    upsertStoredHermesProject(project);
  }

  return {
    success: true,
    project,
    projects: listStoredHermesProjects(),
    activeId: project.id,
    connecting: false,
    rpcAvailable: rpc.rpcAvailable,
  };
}

export async function createEmptyHermesProject(
  payload: HermesProjectCreateEmptyPayload
): Promise<HermesProjectResult> {
  const name = payload.name.trim();
  if (!name) {
    return { success: false, error: 'Name is required.' };
  }

  const dataRoot = resolveDataRoot();
  const existing = listStoredHermesProjects();
  const slug = uniqueProjectSlug(name, existing);
  const hostPath = path.join(dataRoot, 'projects', slug);
  await fs.promises.mkdir(hostPath, { recursive: true });

  const now = new Date().toISOString();
  const containerPath = containerPathForSlug(slug);
  const project: HermesProjectRecord = {
    id: randomUUID(),
    name,
    hostPath,
    containerPath,
    slug,
    kind: 'empty',
    hermesProjectId: `fs:${containerPath}`,
    inference: payload.inference ?? { mode: 'inherit' },
    createdAt: now,
    updatedAt: now,
  };

  upsertStoredHermesProject(project);
  setActiveHermesProjectId(project.id);

  // Empty projects live under the existing data/projects bind, which the overlay doesn't
  // list, so neither the overlay nor the containers change.

  // Do not projects.create — library mkdir is enough; set_active materializes.
  const rpc = await activateOnGateway(project);
  if (rpc.hermesProjectId) {
    project.hermesProjectId = rpc.hermesProjectId;
    project.updatedAt = new Date().toISOString();
    upsertStoredHermesProject(project);
  }

  return {
    success: true,
    project,
    projects: listStoredHermesProjects(),
    activeId: project.id,
    rpcAvailable: rpc.rpcAvailable,
  };
}

/**
 * Save the setup flow's folder picks as projects before the stack is up, so the first
 * `compose up` mounts them (first-run spec, decision 4). Gateway registration waits for
 * {@link applyFirstRunHermesProjects}. A folder that is already a project is reused.
 */
export function stageHostFolderHermesProjects(
  hostPaths: readonly string[]
): HermesProjectRecord[] {
  return hostPaths.map((raw) => {
    const hostPath = path.resolve(raw);
    const existing = listStoredHermesProjects().find(
      (project) => project.kind === 'host-folder' && samePath(project.hostPath, hostPath)
    );
    if (existing) return existing;
    const project = hostFolderRecord(hostPath);
    upsertStoredHermesProject(project);
    return project;
  });
}

/**
 * Create the Folders step's projects once the stack is ready: at most one recreate (none when
 * the first `up` already mounted the folders), each project registered with the gateway, and
 * the first pick selected.
 */
export async function applyFirstRunHermesProjects(
  folders: readonly FirstRunFolder[]
): Promise<{ success: boolean; error?: string; activeId: string | null }> {
  const hostPaths = folders.flatMap((folder) =>
    folder.kind === 'host-folder' ? [folder.hostPath] : []
  );
  const localStackError = hostPaths.length > 0 ? localStackHostFolderError() : null;
  if (localStackError) {
    return { success: false, error: localStackError, activeId: getActiveHermesProjectId() };
  }
  const staged = stageHostFolderHermesProjects(hostPaths);
  if (hostPaths.length > 0 && !areProjectFoldersMounted(hostPaths)) {
    // A pick the recreate fails to mount comes out of the store, or every later `up`
    // would try to mount it again. Picks the running container has already stay.
    const unmounted = staged.filter((project) => !areProjectFoldersMounted([project.hostPath]));
    const mount = await syncOverlayAndRecreate({
      mountLabel: hostPaths.join(', '),
      rollback: () => {
        for (const project of unmounted) removeStoredHermesProject(project.id);
      },
    });
    if (!mount.success) {
      return { success: false, error: mount.error, activeId: getActiveHermesProjectId() };
    }
  }

  const ordered: HermesProjectRecord[] = [];
  let stagedIndex = 0;
  for (const folder of folders) {
    if (folder.kind === 'host-folder') {
      ordered.push(staged[stagedIndex++]);
      continue;
    }
    const created = await createEmptyHermesProject({ name: folder.name });
    if (!created.success || !created.project) {
      return {
        success: false,
        error: created.error ?? `Could not create ${folder.name}.`,
        activeId: getActiveHermesProjectId(),
      };
    }
    ordered.push(created.project);
  }
  if (ordered.length === 0) return { success: true, activeId: getActiveHermesProjectId() };

  // The first pick goes last, so it ends up as the gateway's active project too.
  for (const project of [...ordered.slice(1), ordered[0]]) {
    const rpc = await activateOnGateway(project);
    if (rpc.hermesProjectId && rpc.hermesProjectId !== project.hermesProjectId) {
      upsertStoredHermesProject({
        ...project,
        hermesProjectId: rpc.hermesProjectId,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  setActiveHermesProjectId(ordered[0].id);
  return { success: true, activeId: ordered[0].id };
}

export async function selectHermesProject(
  payload: HermesProjectSelectPayload
): Promise<HermesProjectResult> {
  // The rail's project only: no chat's folder changes here (ADR 0024 §3).
  const { projectId } = payload;
  setActiveHermesProjectId(projectId);

  if (!projectId) {
    try {
      const gateway = getHermesGatewaySession();
      await gateway.setActiveProject(null);
    } catch {
      /* optional */
    }
    return {
      success: true,
      projects: listStoredHermesProjects(),
      activeId: null,
    };
  }

  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }

  // Bump recency so the picker lists last-used first.
  project.updatedAt = new Date().toISOString();
  upsertStoredHermesProject(project);

  const rpc = await activateOnGateway(project);
  if (rpc.hermesProjectId && rpc.hermesProjectId !== project.hermesProjectId) {
    project.hermesProjectId = rpc.hermesProjectId;
    project.updatedAt = new Date().toISOString();
    upsertStoredHermesProject(project);
  }

  return {
    success: true,
    project,
    projects: listStoredHermesProjects(),
    activeId: project.id,
    rpcAvailable: rpc.rpcAvailable,
  };
}

async function normalizeProjectInference(
  pin: ProjectInferencePin
): Promise<{ ok: true; inference: ProjectInferencePin } | { ok: false; error: string }> {
  if (pin.mode === 'inherit') {
    return {
      ok: true,
      inference: {
        mode: 'inherit',
        ...(pin.privacyLocalOnly !== undefined
          ? { privacyLocalOnly: pin.privacyLocalOnly }
          : {}),
      },
    };
  }
  if (pin.mode !== 'local' && pin.mode !== 'openrouter') {
    return { ok: false, error: 'Invalid inference mode.' };
  }
  const connection = await getSlotLlmConnection(pin.mode);
  if (!connection) {
    return { ok: false, error: 'That provider is not connected.' };
  }
  const modelId = (pin.modelId?.trim() || connection.modelId).trim();
  if (!modelId) {
    return { ok: false, error: 'Model is required when pinning a provider.' };
  }
  const kept = await keepChainFallbacks({ slot: pin.mode, modelId }, pin.fallbacks ?? []);
  if (kept.ok === false) return { ok: false, error: kept.error };
  return {
    ok: true,
    inference: {
      mode: pin.mode,
      modelId,
      ...(pin.privacyLocalOnly !== undefined
        ? { privacyLocalOnly: pin.privacyLocalOnly }
        : {}),
      ...(kept.fallbacks.length ? { fallbacks: kept.fallbacks } : {}),
    },
  };
}

/**
 * Patch project inference pin. Does not remount or restart Hermes.
 */
export async function patchHermesProject(
  payload: HermesProjectPatchPayload
): Promise<HermesProjectResult> {
  const project = getStoredHermesProject(payload.projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  const normalized = await normalizeProjectInference(payload.inference);
  // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
  if (normalized.ok === false) {
    return {
      success: false,
      error: normalized.error,
      project,
      projects: listStoredHermesProjects(),
      activeId: getActiveHermesProjectId(),
    };
  }
  project.inference = normalized.inference;
  project.updatedAt = new Date().toISOString();
  upsertStoredHermesProject(project);
  return {
    success: true,
    project,
    projects: listStoredHermesProjects(),
    activeId: getActiveHermesProjectId(),
  };
}

/** Reset pins that named a disconnected visible provider to inherit. */
export function clearProjectInferenceForProvider(
  provider: ChatInferenceProvider
): void {
  const projects = listStoredHermesProjects();
  let changed = false;
  const next = projects.map((project) => {
    if (project.inference?.mode !== provider) return project;
    changed = true;
    return {
      ...project,
      inference: {
        mode: 'inherit' as const,
        ...(project.inference.privacyLocalOnly !== undefined
          ? { privacyLocalOnly: project.inference.privacyLocalOnly }
          : {}),
      },
      updatedAt: new Date().toISOString(),
    };
  });
  if (changed) {
    replaceStoredHermesProjects(next);
  }
}

/** Point project pins for a provider at its newly saved model (see retargetSessionInferenceModel). */
export function retargetProjectInferenceModel(
  provider: ChatInferenceProvider,
  modelId: string
): void {
  const projects = listStoredHermesProjects();
  let changed = false;
  const next = projects.map((project) => {
    if (project.inference?.mode !== provider || project.inference.modelId === modelId) {
      return project;
    }
    changed = true;
    return {
      ...project,
      inference: { ...project.inference, modelId },
      updatedAt: new Date().toISOString(),
    };
  });
  if (changed) {
    replaceStoredHermesProjects(next);
  }
}

export async function changeHermesProjectFolder(
  payload: HermesProjectChangeFolderPayload
): Promise<HermesProjectResult> {
  const project = getStoredHermesProject(payload.projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  const localStackError = localStackHostFolderError();
  if (localStackError) return { success: false, error: localStackError };

  const hostPath = path.resolve(payload.hostPath);
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    return { success: false, error: `Folder not found: ${hostPath}` };
  }

  let hadCoding = false;
  let previous: HermesProjectRecord | null = null;
  let previousActiveId: string | null = null;
  const mount = await syncOverlayAndRecreate({
    mountLabel: hostPath,
    prepare: () => {
      previous = getStoredHermesProject(project.id);
      if (!previous) throw new Error('Project not found.');
      previousActiveId = getActiveHermesProjectId();
      // Coding access was granted for the old folder; a new folder starts with it off (ADR 0028 §12).
      hadCoding = Boolean(previous.codingEnabled) && !samePath(previous.hostPath, hostPath);
      Object.assign(project, previous, {
        hostPath,
        kind: 'host-folder',
        updatedAt: new Date().toISOString(),
      });
      if (hadCoding) project.codingEnabled = false;
      upsertStoredHermesProject(project);
      setActiveHermesProjectId(project.id);
    },
    rollback: () => {
      if (previous) upsertStoredHermesProject(previous);
      if (getActiveHermesProjectId() === project.id) setActiveHermesProjectId(previousActiveId);
    },
  });
  if (!mount.success) {
    return { success: false, error: mount.error };
  }
  if (hadCoding) {
    // Drop the old folder's mount from the coding agent.
    await scheduleCodingRemount();
  }

  const rpc = await activateOnGateway(project);
  if (rpc.hermesProjectId) {
    project.hermesProjectId = rpc.hermesProjectId;
    project.updatedAt = new Date().toISOString();
    upsertStoredHermesProject(project);
  }

  return {
    success: true,
    project,
    projects: listStoredHermesProjects(),
    activeId: project.id,
    rpcAvailable: rpc.rpcAvailable,
  };
}

export async function revealHermesProjectInFinder(
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }
  const error = await shell.openPath(project.hostPath);
  if (error) {
    return { success: false, error };
  }
  return { success: true };
}

export async function completeHermesPath(
  payload: HermesCompletePathPayload
): Promise<HermesCompletePathResult> {
  try {
    const gateway = getHermesGatewaySession();
    const items = await gateway.completePath({
      word: payload.word,
      cwd: payload.cwd,
      sessionId: payload.sessionId,
    });
    return { success: true, items };
  } catch (err) {
    return {
      success: false,
      items: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
