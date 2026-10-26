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
  HermesProjectTreeResult,
  ProjectInferencePin,
} from '../../../../shared/types/hermesChat';
import type { FirstRunFolder } from '../../../../shared/types/setupProgress';
import { getSlotLlmConnection } from '../../onboarding/OpenAiOnboardingStore';
import { recreateHermesForProjectMounts } from '../AssistantStackService';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
import { isLocalAssistantStackMode } from '../localStackMode';
import { getHermesGatewaySession } from './hermesGatewaySession';
import {
  getActiveHermesProjectId,
  getStoredHermesProject,
  listStoredHermesProjects,
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
import { syncProjectsFromGateway } from './hermesProjectsMerge';
import { areProjectFoldersMounted, recordMountedProjectFolders } from './projectMountState';
import { samePath } from './projectSourcesModel';
import { scheduleCodingRemount } from '../coding/codingGrants';
import { persistCodingStackEnv } from '../coding/codingMounts';

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

function resolveDataRoot(): string {
  return resolveAssistantUserContentRoot(resolveActiveAssistantRoot());
}

export async function syncOverlayAndRecreate(options?: {
  extraRoots?: readonly string[];
  mountLabel?: string;
}): Promise<{ success: boolean; error?: string }> {
  const projects = listStoredHermesProjects();
  writeHermesProjectsOverlay(projects, options?.extraRoots);
  // Only Boundary's own stack uses the generated overlay. In local-stack mode the data
  // root is the developer checkout, so leave it alone.
  if (!isLocalAssistantStackMode()) {
    ensureProjectMountPoints(projects, path.join(resolveDataRoot(), 'projects'));
    // Project aliases follow the project list (change request 0003 R2).
    persistCodingStackEnv();
  }
  connecting = true;
  try {
    const result = await recreateHermesForProjectMounts();
    if (!result.success) {
      return {
        success: false,
        error: formatMountError(
          options?.mountLabel ??
            listStoredHermesProjects().find((p) => p.kind === 'host-folder')?.hostPath ??
            'the selected folder',
          result.error ?? 'Failed to reconnect Hermes with the new folder mount.'
        ),
      };
    }
    recordMountedProjectFolders(
      projects.filter((project) => project.kind === 'host-folder').map((project) => project.hostPath)
    );
    return { success: true };
  } finally {
    connecting = false;
  }
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

export async function listHermesProjects(): Promise<HermesProjectsListResult> {
  const stored = listStoredHermesProjects();
  const previousActiveId = getActiveHermesProjectId();
  const dataRoot = resolveDataRoot();

  try {
    const gateway = getHermesGatewaySession();
    await gateway.ensureConnected();
    const listed = await gateway.listProjects();
    const synced = syncProjectsFromGateway({
      stored,
      previousActiveId,
      gateway: {
        projects: listed.projects,
        activeId: listed.activeId,
      },
      dataRoot,
    });
    replaceStoredHermesProjects(synced.projects);
    setActiveHermesProjectId(synced.activeId);
    writeHermesProjectsOverlay(synced.projects);
    return listResult({ rpcAvailable: true });
  } catch {
    // Offline / gateway down: keep store as-is (including host-folder mounts).
    return listResult({ rpcAvailable: false });
  }
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
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
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
  const hostPath = path.resolve(payload.hostPath);
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    return { success: false, error: `Folder not found: ${hostPath}` };
  }

  const project = hostFolderRecord(hostPath, payload.name, payload.inference);
  upsertStoredHermesProject(project);
  setActiveHermesProjectId(project.id);

  const mount = await syncOverlayAndRecreate();
  if (!mount.success) {
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

  // Empty projects use the existing data/projects bind — no compose recreate.
  writeHermesProjectsOverlay(listStoredHermesProjects());

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
  const staged = stageHostFolderHermesProjects(hostPaths);
  if (hostPaths.length > 0 && !areProjectFoldersMounted(hostPaths)) {
    const mount = await syncOverlayAndRecreate({ mountLabel: hostPaths.join(', ') });
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
  return {
    ok: true,
    inference: {
      mode: pin.mode,
      modelId,
      ...(pin.privacyLocalOnly !== undefined
        ? { privacyLocalOnly: pin.privacyLocalOnly }
        : {}),
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

export async function changeHermesProjectFolder(
  payload: HermesProjectChangeFolderPayload
): Promise<HermesProjectResult> {
  const project = getStoredHermesProject(payload.projectId);
  if (!project) {
    return { success: false, error: 'Project not found.' };
  }

  const hostPath = path.resolve(payload.hostPath);
  if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isDirectory()) {
    return { success: false, error: `Folder not found: ${hostPath}` };
  }

  // Coding access was granted for the old folder; a new folder starts with it off (ADR 0028 §12).
  const hadCoding = Boolean(project.codingEnabled) && !samePath(project.hostPath, hostPath);
  project.hostPath = hostPath;
  project.kind = 'host-folder';
  if (hadCoding) project.codingEnabled = false;
  project.updatedAt = new Date().toISOString();
  upsertStoredHermesProject(project);
  setActiveHermesProjectId(project.id);

  const mount = await syncOverlayAndRecreate();
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

export async function listHermesProjectTree(
  projectId: string
): Promise<HermesProjectTreeResult> {
  const project = getStoredHermesProject(projectId);
  if (!project) {
    return { success: false, entries: [], error: 'Project not found.' };
  }
  try {
    const names = await fs.promises.readdir(project.hostPath);
    const entries = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(project.hostPath, name);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
      entries.push({ name, relativePath: name, isDirectory });
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { success: true, entries: entries.slice(0, 200) };
  } catch (err) {
    return {
      success: false,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

export function isHermesProjectsConnecting(): boolean {
  return connecting;
}
