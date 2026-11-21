import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import type {
  CodingCreateFolderPayload,
  CodingCreateFolderResult,
  CodingFolderInspect,
  CodingNewFolderCheck,
  CodingNewFolderDefaults,
} from '../../../../shared/types/codingFolders';
import { getStoredHermesProject } from '../hermes/hermesProjectStore';
import { dialogStartFolder, rememberDialogPick } from '../../dialogFolders';
import { stackCapabilityRefusal } from '../../stackHost/capabilities';
import { codingFolderDeps } from './codingFolderDeps';
import {
  codingAgentBusyBlocks,
  codingFoldersFailure as failure,
  codingFoldersResult as result,
  codingGrantDeps,
  grantNewCodingFolder,
  hostFoldersUnavailable,
  unmanagedCodingFolders,
} from './codingGrants';
import { codingGrantRefuseMessage, folderFacts, refuseCodingGrantReason } from './codingGrantRules';
import { listCodingGrantRecords } from './codingGrantStore';

/**
 * Inspect, pick and create folders for the add sheet and New folder… (ADR 0028 §8). Granting
 * a created folder is codingGrants' job; this module only makes the folder.
 */

/** Facts the add sheet shows before the user picks an access level. */
export function inspectCodingFolder(hostPath: string): CodingFolderInspect {
  const resolved = path.resolve(hostPath);
  const { isDirectory, isGit } = folderFacts(resolved);
  if (!isDirectory) return { success: false, error: `Folder not found: ${resolved}` };
  const reason = refuseCodingGrantReason(resolved, codingGrantDeps().ruleOptions());
  return {
    success: true,
    hostPath: resolved,
    name: path.basename(resolved),
    isGit,
    refuseMessage: reason ? codingGrantRefuseMessage(reason) : null,
    managed: !codingGrantDeps().isLocalStack(),
  };
}

/** The add sheet's native picker, with New Folder available. */
export async function pickCodingFolder(): Promise<CodingFolderInspect> {
  const hostFoldersRefusal = stackCapabilityRefusal('hostFolders');
  if (hostFoldersRefusal) return { success: false, refuseMessage: hostFoldersRefusal };
  const picked = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Add a folder',
    message: 'Choose a repo for the coding agent, or a folder of notes for Hermes to read',
    defaultPath: dialogStartFolder(),
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return { success: false, canceled: true };
  }
  rememberDialogPick(picked.filePaths[0]);
  return inspectCodingFolder(picked.filePaths[0]);
}

const FOLDER_NAME_RE = /^[^/\\:\n\r]+$/;
const ENTRY_COUNT_CAP = 10_000;

function folderNameError(name: string): string | null {
  if (!name) return 'Give the folder a name.';
  if (!FOLDER_NAME_RE.test(name) || name === '.' || name === '..' || name.startsWith('.')) {
    return 'Use a folder name without slashes or colons, not starting with a dot.';
  }
  return null;
}

function parentError(parent: string): string | null {
  // The parent may be home itself (for ~/new-repo): the new folder is what gets granted.
  const reason = refuseCodingGrantReason(parent, codingGrantDeps().ruleOptions());
  if (!reason || reason === 'home') return null;
  return reason === 'missing'
    ? `${parent} doesn’t exist. Choose a folder that does.`
    : codingGrantRefuseMessage(reason);
}

function countEntries(dir: string): number {
  try {
    return Math.min(fs.readdirSync(dir).length, ENTRY_COUNT_CAP);
  } catch {
    return 0;
  }
}

/**
 * Validate a New folder… form as the user types (ADR 0028 §8): the name, the parent, and
 * whether the folder already exists, with what's in it when it does.
 */
export function checkNewCodingFolder(input: { parent: string; name: string }): CodingNewFolderCheck {
  const name = input.name.trim();
  const parent = path.resolve(input.parent);
  const nameError = folderNameError(name);
  if (nameError) return { success: false, error: nameError };
  const badParent = parentError(parent);
  if (badParent) return { success: false, error: badParent };
  const hostPath = path.join(parent, name);
  if (!fs.existsSync(hostPath)) return { success: true, hostPath, exists: false };
  const { isDirectory, isGit } = folderFacts(hostPath);
  return {
    success: true,
    hostPath,
    exists: true,
    isDirectory,
    isGit,
    entries: isDirectory ? countEntries(hostPath) : 0,
  };
}

function mostRecentGrantParent(): string | null {
  const grants = [...listCodingGrantRecords()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
  for (const grant of grants) {
    const parent = path.dirname(grant.resource);
    if (!parentError(parent)) return parent;
  }
  return null;
}

/** Where New folder… starts, and whether git can start a repo there. */
export async function newCodingFolderDefaults(): Promise<CodingNewFolderDefaults> {
  const home = codingGrantDeps().ruleOptions().home;
  const code = path.join(home, 'Code');
  const defaultParent =
    mostRecentGrantParent() ?? (!parentError(code) ? code : home);
  return {
    defaultParent,
    gitAvailable: await codingFolderDeps().gitAvailable(),
    managed: !codingGrantDeps().isLocalStack(),
  };
}

/** Choose the parent for a new folder; the picker can make one too. */
export async function pickCodingParent(defaultPath?: string): Promise<{
  success: boolean;
  canceled?: boolean;
  hostPath?: string;
  error?: string;
}> {
  const picked = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose where to create the folder',
    defaultPath: defaultPath ?? dialogStartFolder(),
  });
  if (picked.canceled || picked.filePaths.length === 0) return { success: false, canceled: true };
  rememberDialogPick(picked.filePaths[0]);
  const parent = path.resolve(picked.filePaths[0]);
  const error = parentError(parent);
  return error ? { success: false, error } : { success: true, hostPath: parent };
}

async function startGitRepo(hostPath: string): Promise<void> {
  await codingFolderDeps().runGit(hostPath, ['init']);
  await codingFolderDeps().runGit(hostPath, ['commit', '--allow-empty', '-m', 'Start']).catch(() =>
    // No git identity configured: commit as Boundary rather than leave no first commit.
    codingFolderDeps().runGit(hostPath, [
      '-c',
      'user.name=Boundary',
      '-c',
      'user.email=boundary@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'Start',
    ])
  );
}

/**
 * Create a new, empty folder (ADR 0028 §8) and, unless `grant` is false, give the coding
 * agent access to it. Never creates over an existing path and never creates missing parents.
 * With `grant: false` the folder is for read-only reference, so it works on any stack.
 */
export async function createCodingFolder(
  payload: CodingCreateFolderPayload
): Promise<CodingCreateFolderResult> {
  const unavailable = hostFoldersUnavailable();
  if (unavailable) return unavailable;
  const grant = payload.grant !== false;
  if (grant && codingGrantDeps().isLocalStack()) return unmanagedCodingFolders();
  const check = checkNewCodingFolder(payload);
  if (!check.success || !check.hostPath) return failure(check.error ?? 'That folder can’t be created.');
  const hostPath = check.hostPath;
  if (check.exists) {
    return { ...failure(`${hostPath} already exists.`), exists: true, hostPath };
  }
  if (payload.projectId && !getStoredHermesProject(payload.projectId)) {
    return failure('Project not found.');
  }
  if (grant) {
    const busy = await codingAgentBusyBlocks(payload.stopRunningTask);
    if (busy) return { ...failure('A coding task is running.', { busy }), hostPath };
  }

  try {
    fs.mkdirSync(hostPath);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  if (payload.initGit) {
    try {
      await startGitRepo(hostPath);
    } catch (error) {
      return {
        ...failure(
          `Created ${hostPath}, but git didn’t start a repo there: ${
            error instanceof Error ? error.message : String(error)
          }`
        ),
        hostPath,
      };
    }
  }
  if (!grant) return { ...result(), hostPath };
  return { ...(await grantNewCodingFolder(hostPath, payload.projectId)), hostPath };
}
