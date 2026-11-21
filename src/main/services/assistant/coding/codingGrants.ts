import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { broadcast } from '../../windows';
import type {
  CodingAgentBusy,
  CodingFoldersResult,
  CodingGrantPayload,
  CodingGrantRow,
  CodingProjectFolderPayload,
  CodingRevokePayload,
} from '../../../../shared/types/codingFolders';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { resolveAssistantStackHome } from '../assistantPaths';
import {
  getProjectEnv,
  isCodingRootVisible,
  recreateCodingAgentForMounts,
  recreateHermesForProjectMounts,
} from '../AssistantStackService';
import {
  getStoredHermesProject,
  listStoredHermesProjects,
  upsertStoredHermesProject,
} from '../hermes/hermesProjectStore';
import { writeHermesProjectsOverlay } from '../hermes/hermesProjectsOverlay';
import {
  enqueueFolderRemount,
  resetFolderRemountQueueForTests,
  type FolderRemountOutcome,
} from '../hermes/projectMountState';
import { isPathUnder } from '../../hostPaths';
import { appendAudit, trimForAudit, type AuditEntry } from '../../hostBridge/auditLog';
import { isLocalAssistantStackMode } from '../localStackMode';
import { codingAgentBusy } from './codingAgentBusy';
import {
  codingGrantRefuseMessage,
  refuseCodingGrantReason,
  type CodingGrantRuleOptions,
} from './codingGrantRules';
import {
  addCodingGrantRecord,
  findCodingGrant,
  getCodingGrantStates,
  isHermesPending,
  listCodingGrantRecords,
  removeCodingGrantRecord,
  setCodingGrantState,
} from './codingGrantStore';
import { codingGrantPaths, currentCodingRoots, persistCodingStackEnv } from './codingMounts';
import { APP_NAME } from '../../../../shared/buildIdentity';
import { stackCapabilityRefusal } from '../../stackHost/capabilities';

/**
 * Coding grants (ADR 0028): record a grant, mount it on the coding agent, restart only the
 * coding agent, and check the folder is visible before calling it ready. Every change goes
 * through the folder remount queue, so it never overlaps a project or source remount, and
 * grants made while a coding remount is waiting share its restart.
 */

export interface CodingGrantDeps {
  isLocalStack: () => boolean;
  busy: () => Promise<CodingAgentBusy>;
  writeOverlay: () => void | Promise<void>;
  persistEnv: (roots: readonly string[]) => void | Promise<void>;
  recreate: (onProgress: (message: string) => void) => Promise<{ success: boolean; error?: string }>;
  verify: (hostPath: string) => Promise<boolean>;
  restartHermes: () => Promise<{ success: boolean; error?: string }>;
  ruleOptions: () => CodingGrantRuleOptions;
  progress: (message: string) => void;
  /** Append to the host bridge's audit log (ADR 0027 §7). */
  audit: (entry: AuditEntry) => void;
}


function broadcastProgress(message: string): void {
  broadcast('coding-folders:progress', message);
}

const defaultDeps: CodingGrantDeps = {
  isLocalStack: isLocalAssistantStackMode,
  busy: () => codingAgentBusy(),
  writeOverlay: async () => {
    await writeHermesProjectsOverlay(listStoredHermesProjects());
  },
  persistEnv: (roots) => persistCodingStackEnv(getProjectEnv(), roots),
  recreate: recreateCodingAgentForMounts,
  verify: isCodingRootVisible,
  restartHermes: recreateHermesForProjectMounts,
  ruleOptions: () => ({
    home: os.homedir(),
    boundaryDataPaths: [app.getPath('userData'), resolveAssistantStackHome()],
  }),
  progress: broadcastProgress,
  audit: (entry) => appendAudit({ ...entry, args: trimForAudit(entry.args) }),
};

let deps: CodingGrantDeps = defaultDeps;

/** Test-only: swap side effects. */
export function setCodingGrantDepsForTests(next: Partial<CodingGrantDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

const LOCAL_STACK_COMMAND = 'make coding-root-add DIR=<absolute path>';

// --- Rows -------------------------------------------------------------------

function projectFolderRow(project: HermesProjectRecord): CodingGrantRow {
  const resource = path.resolve(project.hostPath);
  return {
    capability: 'coding',
    resource,
    createdAt: project.updatedAt,
    expiresAt: null,
    projectId: project.id,
    origin: 'project-folder',
    createdByBoundary: false,
    state: getCodingGrantStates()[resource] ?? 'ready',
    // Hermes already edits a project's own folder through /opt/projects/<slug>.
    hermesPending: false,
  };
}

function listCodingGrantRows(): CodingGrantRow[] {
  const states = getCodingGrantStates();
  const records: CodingGrantRow[] = listCodingGrantRecords().map((grant) => ({
    ...grant,
    state: states[grant.resource] ?? 'ready',
    hermesPending: isHermesPending(grant.resource),
  }));
  const hubs = listStoredHermesProjects()
    .filter((project) => project.kind === 'host-folder' && project.codingEnabled)
    .map((project) => projectFolderRow(project));
  return [...hubs, ...records];
}

function result(partial: Partial<CodingFoldersResult> = {}): CodingFoldersResult {
  return { success: true, managed: true, grants: listCodingGrantRows(), ...partial };
}

function unmanaged(): CodingFoldersResult {
  return {
    success: false,
    managed: false,
    grants: [],
    command: LOCAL_STACK_COMMAND,
    error:
      `This ${APP_NAME} is using your own stack checkout. Add coding folders there with make coding-root-add.`,
  };
}

/** The refusal when this stack can't share host folders, or null when it can. */
export function hostFoldersUnavailable(): CodingFoldersResult | null {
  const refusal = stackCapabilityRefusal('hostFolders');
  return refusal ? { success: false, managed: true, grants: [], error: refusal } : null;
}

function failure(error: string, partial: Partial<CodingFoldersResult> = {}): CodingFoldersResult {
  return result({ success: false, error, ...partial });
}

// --- Remount queue ------------------------------------------------------------

type RemountOutcome = FolderRemountOutcome;

/** A coding remount queued and not yet started; later callers share it. */
let waiting: Promise<RemountOutcome> | null = null;

/**
 * Every granted path, covered or not. State is kept per grant, so a grant inside another
 * one is checked too, not only the mount roots (G10-1).
 */
function grantPathsToCheck(): string[] {
  return [...new Set(codingGrantPaths().map((grantPath) => path.resolve(grantPath)))];
}

async function checkGrantsVisible(): Promise<void> {
  for (const grantPath of grantPathsToCheck()) {
    setCodingGrantState(grantPath, (await deps.verify(grantPath)) ? 'ready' : 'not-visible');
  }
}

/** True when another grant's mount already holds the path, so adding or removing it changes no mount. */
export function isCoveredByOtherGrant(hostPath: string): boolean {
  const resolved = path.resolve(hostPath);
  return currentCodingRoots().some((root) => root !== resolved && isPathUnder(resolved, root));
}

async function remountNow(): Promise<RemountOutcome> {
  const roots = currentCodingRoots();
  deps.progress('Saving coding folders…');
  try {
    await deps.writeOverlay();
    await deps.persistEnv(roots);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const recreated = await deps.recreate(deps.progress);
  if (!recreated.success) {
    for (const grantPath of grantPathsToCheck()) setCodingGrantState(grantPath, 'not-visible');
    return { success: false, error: recreated.error ?? 'The coding agent didn’t restart.' };
  }
  deps.progress('Checking the coding agent can open each folder…');
  await checkGrantsVisible();
  return { success: true };
}

/**
 * Run a coding remount in the folder remount queue, after any project or source remount
 * ahead of it. Callers that arrive while one is already waiting join it, since it will
 * read the grant list when it starts.
 */
export function scheduleCodingRemount(): Promise<RemountOutcome> {
  if (waiting) return waiting;
  const next = enqueueFolderRemount((): Promise<RemountOutcome> => {
    waiting = null;
    return remountNow();
  });
  waiting = next;
  return next;
}

export type CodingAuditTool = 'coding_grant' | 'coding_revoke' | 'coding_delete';

/**
 * Record a change to coding access in the host bridge's audit log, beside the bridge's own
 * grants (ADR 0028 §3). `failure` makes it an error entry with that message as the outcome.
 */
export function auditCodingChange(
  tool: CodingAuditTool,
  args: Record<string, unknown>,
  outcome: string,
  failure?: string
): void {
  deps.audit({ tool, decision: failure ? 'error' : 'allowed', args, outcome: failure ?? outcome });
}

function grantStateOutcome(hostPath: string): string {
  return getCodingGrantStates()[path.resolve(hostPath)] === 'not-visible' ? 'not visible' : 'ready';
}

/** Check the coding agent can open a folder that needed no restart, record that and audit the grant. */
async function recordGrantState(hostPath: string, auditArgs: Record<string, unknown>): Promise<void> {
  setCodingGrantState(hostPath, (await deps.verify(hostPath)) ? 'ready' : 'not-visible');
  auditCodingChange('coding_grant', auditArgs, grantStateOutcome(hostPath));
}

function remountError(outcome: RemountOutcome): string | undefined {
  return outcome.success ? undefined : (outcome.error ?? 'The coding agent couldn’t be updated.');
}

function remountFailure(outcome: RemountOutcome): CodingFoldersResult {
  return failure(remountError(outcome));
}

async function busyBlocks(stopRunningTask: boolean | undefined): Promise<CodingAgentBusy | null> {
  if (stopRunningTask) return null;
  const busy = await deps.busy();
  return busy.busy ? busy : null;
}

function notVisibleMessage(hostPath: string): string {
  const home = deps.ruleOptions().home;
  return isPathUnder(hostPath, home)
    ? `The coding agent can’t open ${hostPath} yet. Check the folder still exists, then try again.`
    : `The coding agent can’t open ${hostPath}. ${APP_NAME}’s container engine only shares your home folder. Move the folder under your home folder, or share its drive in the container engine’s settings, then try again.`;
}

// --- Operations ---------------------------------------------------------------

export function listCodingGrants(): CodingFoldersResult {
  if (deps.isLocalStack()) return unmanaged();
  return result();
}

export async function grantCoding(payload: CodingGrantPayload): Promise<CodingFoldersResult> {
  const unavailable = hostFoldersUnavailable();
  if (unavailable) return unavailable;
  if (deps.isLocalStack()) return unmanaged();
  const hostPath = path.resolve(payload.hostPath);
  const reason = refuseCodingGrantReason(hostPath, deps.ruleOptions());
  if (reason) return failure(codingGrantRefuseMessage(reason));
  if (payload.projectId && !getStoredHermesProject(payload.projectId)) {
    return failure('Project not found.');
  }
  if (findCodingGrant(hostPath)) return result();

  // Under an existing root, the mount and allowlist already cover it.
  const covered = isCodingMounted(hostPath);
  if (!covered) {
    const busy = await busyBlocks(payload.stopRunningTask);
    if (busy) return failure('A coding task is running.', { busy });
  }
  addCodingGrantRecord({
    hostPath,
    projectId: payload.projectId,
    origin: payload.origin,
    createdByBoundary: false,
  });
  const auditArgs = { path: hostPath, projectId: payload.projectId, origin: payload.origin };
  if (covered) {
    await recordGrantState(hostPath, auditArgs);
    return result();
  }
  const outcome = await scheduleCodingRemount();
  auditCodingChange('coding_grant', auditArgs, grantStateOutcome(hostPath), remountError(outcome));
  if (!outcome.success) return remountFailure(outcome);
  if (getCodingGrantStates()[hostPath] === 'not-visible') {
    return failure(notVisibleMessage(hostPath));
  }
  return result();
}

export async function setProjectFolderCoding(
  payload: CodingProjectFolderPayload
): Promise<CodingFoldersResult> {
  const unavailable = hostFoldersUnavailable();
  if (unavailable) return unavailable;
  if (deps.isLocalStack()) return unmanaged();
  const project = getStoredHermesProject(payload.projectId);
  if (!project) return failure('Project not found.');
  if (project.kind !== 'host-folder') {
    return failure('Only projects with a folder on this Mac can use the coding agent.');
  }
  if (Boolean(project.codingEnabled) === payload.enabled) return result();
  if (payload.enabled) {
    const reason = refuseCodingGrantReason(project.hostPath, deps.ruleOptions());
    if (reason) return failure(codingGrantRefuseMessage(reason));
  }
  const busy = await busyBlocks(payload.stopRunningTask);
  if (busy) return failure('A coding task is running.', { busy });
  upsertStoredHermesProject({
    ...project,
    codingEnabled: payload.enabled,
    updatedAt: new Date().toISOString(),
  });
  const outcome = await scheduleCodingRemount();
  const hostPath = path.resolve(project.hostPath);
  if (payload.enabled) {
    auditCodingChange(
      'coding_grant',
      { path: hostPath, projectId: project.id, origin: 'project-folder' },
      grantStateOutcome(hostPath),
      remountError(outcome)
    );
  } else {
    auditCodingChange(
      'coding_revoke',
      { path: hostPath, projectId: project.id },
      'removed',
      remountError(outcome)
    );
  }
  if (!outcome.success) return remountFailure(outcome);
  if (payload.enabled && getCodingGrantStates()[hostPath] === 'not-visible') {
    return failure(notVisibleMessage(hostPath));
  }
  return result();
}

/**
 * For a new project whose folder gets coding in the same restart as its mount: why the
 * folder can't have coding, or null when it can.
 */
export function projectFolderCodingRefusal(hostPath: string): string | null {
  const reason = refuseCodingGrantReason(path.resolve(hostPath), deps.ruleOptions());
  return reason ? codingGrantRefuseMessage(reason) : null;
}

/** True when a granted folder's mount already holds this path, so no coding restart is needed. */
export function isCodingMounted(hostPath: string): boolean {
  const resolved = path.resolve(hostPath);
  return currentCodingRoots().some((root) => isPathUnder(resolved, root));
}

/**
 * After the restart that mounted a new project's folder with coding on: check the coding
 * agent can open it, record its state and audit the grant. Returns the message to show
 * when it can't, or null. With `failure`, the restart failed and the project was rolled
 * back, so this only audits that.
 */
export async function finishProjectFolderGrant(
  project: Pick<HermesProjectRecord, 'id' | 'hostPath'>,
  failure?: string
): Promise<string | null> {
  const hostPath = path.resolve(project.hostPath);
  const args = { path: hostPath, projectId: project.id, origin: 'project-folder' };
  if (failure) {
    auditCodingChange('coding_grant', args, 'not added', failure);
    return null;
  }
  await recordGrantState(hostPath, args);
  return getCodingGrantStates()[hostPath] === 'not-visible' ? notVisibleMessage(hostPath) : null;
}

export async function revokeCoding(payload: CodingRevokePayload): Promise<CodingFoldersResult> {
  if (deps.isLocalStack()) return unmanaged();
  if (!findCodingGrant(payload.hostPath)) return result();
  // Inside another grant: that grant's mount stays, so nothing restarts (G10-15).
  const auditArgs = { path: path.resolve(payload.hostPath) };
  if (isCoveredByOtherGrant(payload.hostPath)) {
    removeCodingGrantRecord(payload.hostPath);
    auditCodingChange('coding_revoke', auditArgs, 'removed');
    return result();
  }
  const busy = await busyBlocks(payload.stopRunningTask);
  if (busy) return failure('A coding task is running.', { busy });
  removeCodingGrantRecord(payload.hostPath);
  const outcome = await scheduleCodingRemount();
  auditCodingChange('coding_revoke', auditArgs, 'removed', remountError(outcome));
  return outcome.success ? result() : remountFailure(outcome);
}

/** Recreate Hermes so its own edits reach every granted folder (ADR 0028 §4). */
export async function restartHermesForCodingGrants(): Promise<CodingFoldersResult> {
  if (deps.isLocalStack()) return unmanaged();
  const restarted = await deps.restartHermes();
  return restarted.success
    ? result()
    : failure(restarted.error ?? 'Hermes didn’t restart.');
}

export async function codingFoldersBusy(): Promise<CodingAgentBusy> {
  return deps.busy();
}

/** The side effects in use, for the folder actions built on top of grants. */
export function codingGrantDeps(): CodingGrantDeps {
  return deps;
}

const CODING_VERIFY_CACHE_MS = 60_000;
let lastVerifiedAt = 0;

/**
 * Re-check that the coding agent can open every granted folder, for Settings. Cached for a
 * minute so opening Settings repeatedly doesn't exec into the container each time.
 */
export async function verifyCodingGrants(force = false): Promise<CodingFoldersResult> {
  if (deps.isLocalStack()) return unmanaged();
  const now = Date.now();
  if (!force && now - lastVerifiedAt < CODING_VERIFY_CACHE_MS) return result();
  await checkGrantsVisible();
  lastVerifiedAt = Date.now();
  return result();
}

/** Remount every grant again, for a folder the coding agent couldn't open. */
export async function retryCodingMounts(): Promise<CodingFoldersResult> {
  if (deps.isLocalStack()) return unmanaged();
  const outcome = await scheduleCodingRemount();
  return outcome.success ? result() : remountFailure(outcome);
}

/**
 * The grant half of New folder… (ADR 0028 §8): give the coding agent access to a folder
 * Boundary just created, restarting it unless another grant's mount already holds the folder.
 */
export async function grantNewCodingFolder(
  hostPath: string,
  projectId: string | null | undefined
): Promise<CodingFoldersResult> {
  addCodingGrantRecord({
    hostPath,
    projectId,
    origin: 'new-folder',
    createdByBoundary: true,
  });
  const auditArgs = { path: hostPath, projectId, origin: 'new-folder' };
  if (isCoveredByOtherGrant(hostPath)) {
    await recordGrantState(hostPath, auditArgs);
    return result();
  }
  const outcome = await scheduleCodingRemount();
  auditCodingChange('coding_grant', auditArgs, grantStateOutcome(hostPath), remountError(outcome));
  return outcome.success ? result() : remountFailure(outcome);
}

/** The result shapes and busy check that New folder… shares with grants. */
export {
  busyBlocks as codingAgentBusyBlocks,
  failure as codingFoldersFailure,
  result as codingFoldersResult,
  unmanaged as unmanagedCodingFolders,
};

/** Test-only: forget queued remounts. */
export function resetCodingRemountQueueForTests(): void {
  resetFolderRemountQueueForTests();
  waiting = null;
  lastVerifiedAt = 0;
}
