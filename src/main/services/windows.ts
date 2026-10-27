import { BrowserWindow } from 'electron';
import type { IpcEventChannel } from '../../shared/ipc/channels';
import { sendEvent, type IpcEventArgs } from '../ipc';

/** Send one event to every open window, skipping destroyed ones. */
export function broadcast<C extends IpcEventChannel>(channel: C, ...args: IpcEventArgs<C>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) sendEvent(win.webContents, channel, ...args);
  }
}
