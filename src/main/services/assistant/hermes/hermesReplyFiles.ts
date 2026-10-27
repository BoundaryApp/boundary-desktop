import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, dialog, shell, type WebContents } from 'electron';
import type {
  HermesRevealProjectFilePayload,
  HermesRevealProjectFileResult,
  HermesSaveReplyPayload,
  HermesSaveReplyResult,
} from '../../../../shared/types/hermesChat';
import { slugify } from '../../../../shared/utils/slug';
import { getStoredHermesProject } from './hermesProjectStore';
import { rememberDialogPick } from '../../dialogFolders';
import { isPathUnder } from '../../hostPaths';

/**
 * Reply extras that touch the host (message-actions spec, Phase 4). These are the
 * user's own actions on their machine, not agent actions: Save writes only where the
 * user picks in the save dialog, and Reveal only opens files inside the project folder.
 */

/** Absolute host path for a project-relative path, or null if it would leave the folder. */
export function resolveInsideProject(hostPath: string, relativePath: string): string | null {
  const target = path.resolve(hostPath, relativePath);
  return isPathUnder(target, hostPath) ? target : null;
}

/** "cover-letter-for-acme.md" from the reply's first heading or line; dated fallback. */
export function suggestReplyFileName(markdown: string, now = new Date()): string {
  const firstLine =
    markdown
      .split('\n')
      .map((line) => line.replace(/^#+\s*|[*_`>]/g, '').trim())
      .find((line) => line.length > 0) ?? '';
  const slug = slugify(firstLine, { max: 48 });
  if (slug) return `${slug}.md`;
  const day = now.toISOString().slice(0, 10);
  return `reply-${day}.md`;
}

export async function saveReplyToProject(
  sender: WebContents,
  payload: HermesSaveReplyPayload
): Promise<HermesSaveReplyResult> {
  const project = getStoredHermesProject(payload.projectId);
  if (!project) return { success: false, error: 'Project not found.' };
  const options = {
    title: `Save to ${project.name}`,
    defaultPath: path.join(project.hostPath, suggestReplyFileName(payload.content)),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return { success: false, canceled: true };
  rememberDialogPick(picked.filePath);
  try {
    const body = payload.content.endsWith('\n') ? payload.content : `${payload.content}\n`;
    await fs.writeFile(picked.filePath, body, 'utf8');
    return { success: true, path: picked.filePath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function revealProjectFile(
  payload: HermesRevealProjectFilePayload
): Promise<HermesRevealProjectFileResult> {
  const project = getStoredHermesProject(payload.projectId);
  if (!project) return { success: false, error: 'Project not found.' };
  const target = resolveInsideProject(project.hostPath, payload.relativePath);
  if (!target) return { success: false, error: 'That file is outside the project folder.' };
  try {
    await fs.access(target);
  } catch {
    return { success: false, error: 'That file no longer exists.' };
  }
  shell.showItemInFolder(target);
  return { success: true };
}
