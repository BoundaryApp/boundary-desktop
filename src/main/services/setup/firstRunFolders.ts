import path from 'node:path';
import { dialog } from 'electron';
import type {
  ApplyFirstRunFoldersResult,
  FirstRunFolder,
  FirstRunFolderPick,
  PickFirstRunFoldersResult,
  SaveFirstRunFoldersResult,
} from '../../../shared/types/setupProgress';
import { codingGrantDeps } from '../assistant/coding/codingGrants';
import {
  codingGrantRefuseMessage,
  refuseCodingGrantReason,
} from '../assistant/coding/codingGrantRules';
import {
  applyFirstRunHermesProjects,
  stageHostFolderHermesProjects,
} from '../assistant/hermes/hermesProjects';
import { displayHostPath } from '../assistant/hermes/hermesProjectsOverlay';
import { dialogStartFolder, rememberDialogPick } from '../dialogFolders';
import {
  getSetupProgress,
  recordOptionalStepOutcome,
  setPendingFirstRunFolders,
} from './SetupProgressStore';

/** The setup flow's Folders step (first-run spec, Phase 2). */
const FOLDERS_STEP_ID = 'folders';

/** A picked folder with the ADR 0028 §5 refusal, if any. */
export function judgeFirstRunFolder(hostPath: string): FirstRunFolderPick {
  const resolved = path.resolve(hostPath);
  const reason = refuseCodingGrantReason(resolved, codingGrantDeps().ruleOptions());
  return {
    hostPath: resolved,
    name: path.basename(resolved) || resolved,
    displayPath: displayHostPath(resolved),
    refuseMessage: reason ? codingGrantRefuseMessage(reason) : null,
  };
}

export async function pickFirstRunFolders(): Promise<PickFirstRunFoldersResult> {
  const picked = await dialog.showOpenDialog({
    properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    title: 'Choose folders',
    message: 'Choose folders for your assistant to work in',
    defaultPath: dialogStartFolder(),
  });
  if (picked.canceled || picked.filePaths.length === 0) {
    return { canceled: true, folders: [] };
  }
  rememberDialogPick(picked.filePaths[0]);
  return { folders: picked.filePaths.map(judgeFirstRunFolder) };
}

function failure(error: string): SaveFirstRunFoldersResult {
  return { success: false, error, progress: getSetupProgress() };
}

/**
 * Record the step's picks. Host folders are saved as projects now, so the stack's first
 * `compose up` mounts them; the gateway learns about them in {@link applyFirstRunFolders}.
 */
export function saveFirstRunFolders(folders: readonly FirstRunFolder[]): SaveFirstRunFoldersResult {
  const kept: FirstRunFolder[] = [];
  for (const folder of folders) {
    if (folder.kind === 'empty') {
      const name = folder.name.trim();
      if (!name) return failure('Give the empty project a name.');
      kept.push({ kind: 'empty', name });
      continue;
    }
    const judged = judgeFirstRunFolder(folder.hostPath);
    if (judged.refuseMessage) return failure(`${judged.displayPath}: ${judged.refuseMessage}`);
    if (kept.some((item) => item.kind === 'host-folder' && item.hostPath === judged.hostPath)) {
      continue;
    }
    kept.push({ kind: 'host-folder', hostPath: judged.hostPath });
  }
  if (kept.length === 0) return failure('Choose a folder, or skip this step.');

  stageHostFolderHermesProjects(
    kept.flatMap((folder) => (folder.kind === 'host-folder' ? [folder.hostPath] : []))
  );
  setPendingFirstRunFolders(kept);
  recordOptionalStepOutcome(FOLDERS_STEP_ID, 'done');
  return { success: true, progress: getSetupProgress() };
}

/**
 * Create the saved picks as projects once the stack is ready, and select the first. The picks
 * are cleared whether or not that works: a failure shows in chat, never back in setup.
 */
export async function applyFirstRunFolders(): Promise<ApplyFirstRunFoldersResult> {
  const pending = getSetupProgress().pendingFolders;
  if (pending.length === 0) return { success: true, progress: getSetupProgress() };
  let result: Awaited<ReturnType<typeof applyFirstRunHermesProjects>>;
  try {
    result = await applyFirstRunHermesProjects(pending);
  } catch (error) {
    result = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      activeId: null,
    };
  }
  setPendingFirstRunFolders([]);
  return { ...result, progress: getSetupProgress() };
}
