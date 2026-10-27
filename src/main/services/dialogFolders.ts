import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Store from 'electron-store';

/**
 * Starting folder for native open and save dialogs. Since Electron 43 a dialog without
 * `defaultPath` opens in Downloads and macOS no longer restores the last folder, so every
 * picker passes one from here: the folder that held the user's last pick, or the home
 * directory before the first pick or once that folder is gone.
 */

interface DialogFoldersStoreShape {
  lastFolder?: string;
}

const store = new Store<DialogFoldersStoreShape>({ name: 'dialog-folders' });

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** `defaultPath` for an open dialog. */
export function dialogStartFolder(): string {
  const last = store.get('lastFolder');
  return last && path.isAbsolute(last) && isDirectory(last) ? last : os.homedir();
}

/** `defaultPath` for a save dialog: the start folder joined with the suggested name. */
export function dialogSavePath(fileName: string): string {
  return path.join(dialogStartFolder(), fileName);
}

/**
 * Record a pick so the next dialog opens beside it. Stores the folder that contains the
 * picked file or folder, the one the dialog was showing, as macOS did before Electron 43.
 */
export function rememberDialogPick(picked: string | undefined): void {
  if (!picked || !path.isAbsolute(picked)) return;
  store.set('lastFolder', path.dirname(path.resolve(picked)));
}

export const __testing = {
  reset(): void {
    store.delete('lastFolder');
  },
};
