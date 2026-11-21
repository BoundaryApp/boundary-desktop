import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, dialog, type WebContents } from 'electron';
import {
  WRITING_CHECK_FILE_EXTENSIONS,
  isCheckableFile,
  type WritingCheckFilePayload,
  type WritingCheckFileResult,
  type WritingCheckPickPayload,
} from '../../../../shared/types/writingCheck';
import { persistDebugLog } from '../../../persistDebugLog';
import { rememberDialogPick } from '../../dialogFolders';
import { isPathUnder } from '../../hostPaths';
import { getStoredHermesProject } from './hermesProjectStore';
import { resolveInsideProject } from './hermesReplyFiles';
import { stackCapabilityRefusal } from '../../stackHost/capabilities';

/**
 * Project files for the writing check (writing check spec, phase 4). A user action on the
 * host, like Reveal: main reads only text files inside the project folder, symlinks resolved,
 * up to 1 MB, and hands the text to the renderer, which runs the check.
 */

const MAX_BYTES = 1024 * 1024;

const ERRORS = {
  project: 'Project not found.',
  outside: 'That file is outside the project folder.',
  type: 'Only .md, .markdown and .txt files can be checked.',
  missing: 'That file no longer exists.',
  large: 'That file is over 1 MB, too large to check.',
  binary: 'That file is not plain text.',
} as const;

type Outcome = keyof typeof ERRORS | 'ok' | 'error';

function logRead(outcome: Outcome, relativePath: string, started: number, bytes?: number): void {
  // Metadata only: the path and the text stay out of the log.
  persistDebugLog('writing-check', 'file read', {
    outcome,
    ext: path.extname(relativePath).toLowerCase(),
    ...(bytes !== undefined ? { bytes } : {}),
    ms: Date.now() - started,
  });
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

export async function readProjectFileForCheck(
  payload: WritingCheckFilePayload
): Promise<WritingCheckFileResult> {
  const hostFoldersRefusal = stackCapabilityRefusal('hostFolders');
  if (hostFoldersRefusal) return { success: false, error: hostFoldersRefusal };
  const started = Date.now();
  const refuse = (outcome: keyof typeof ERRORS): WritingCheckFileResult => {
    logRead(outcome, payload.relativePath, started);
    return { success: false, error: ERRORS[outcome] };
  };

  const project = getStoredHermesProject(payload.projectId);
  if (!project) return refuse('project');
  const target = resolveInsideProject(project.hostPath, payload.relativePath);
  if (!target) return refuse('outside');
  if (!isCheckableFile(target)) return refuse('type');

  // A symlink inside the folder may point out of it: compare the resolved paths.
  const real = await realpathOrNull(target);
  if (!real) return refuse('missing');
  const realRoot = (await realpathOrNull(project.hostPath)) ?? project.hostPath;
  if (!isPathUnder(real, realRoot)) return refuse('outside');

  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return refuse('type');
    if (stat.size > MAX_BYTES) return refuse('large');
    const bytes = await fs.readFile(real);
    if (bytes.includes(0)) return refuse('binary');
    logRead('ok', payload.relativePath, started, bytes.length);
    return {
      success: true,
      file: {
        relativePath: path.relative(project.hostPath, target).split(path.sep).join('/'),
        text: bytes.toString('utf8'),
        modifiedAt: stat.mtime.toISOString(),
      },
    };
  } catch (err) {
    logRead('error', payload.relativePath, started);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** **Check a file…**: an open dialog in the project folder, limited to the checkable types. */
export async function pickProjectFileForCheck(
  sender: WebContents,
  payload: WritingCheckPickPayload
): Promise<WritingCheckFileResult> {
  const hostFoldersRefusal = stackCapabilityRefusal('hostFolders');
  if (hostFoldersRefusal) return { success: false, error: hostFoldersRefusal };
  const project = getStoredHermesProject(payload.projectId);
  if (!project) return { success: false, error: ERRORS.project };
  const options = {
    title: `Check a file in ${project.name}`,
    defaultPath: project.hostPath,
    properties: ['openFile' as const],
    filters: [{ name: 'Text', extensions: WRITING_CHECK_FILE_EXTENSIONS.map((e) => e.slice(1)) }],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (picked.canceled || picked.filePaths.length === 0) return { success: false, canceled: true };
  const chosen = picked.filePaths[0];
  rememberDialogPick(chosen);
  if (!isPathUnder(chosen, project.hostPath)) return { success: false, error: ERRORS.outside };
  return readProjectFileForCheck({
    projectId: payload.projectId,
    relativePath: path.relative(project.hostPath, chosen),
  });
}
