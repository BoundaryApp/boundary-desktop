import { BrowserWindow, dialog, type SaveDialogOptions, type WebContents } from 'electron';
import { rememberDialogPick } from './dialogFolders';

/**
 * Show a save dialog over the window that asked, or on its own when there is none. Resolves to
 * the picked path, which is remembered as the next dialog's start folder, or null when canceled.
 */
export async function pickSavePath(sender: WebContents, options: SaveDialogOptions): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(sender);
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) return null;
  rememberDialogPick(picked.filePath);
  return picked.filePath;
}
