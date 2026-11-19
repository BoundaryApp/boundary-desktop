import { app, BrowserWindow } from 'electron';
import type { IpcEventChannel } from '../../shared/ipc/channels';
import { sendEvent, type IpcEventArgs } from '../ipc';
import { isDesktopAgentWindow } from './desktopAgent/desktopAgentWindows';

/** Send one event to every open window, skipping destroyed ones. */
export function broadcast<C extends IpcEventChannel>(channel: C, ...args: IpcEventArgs<C>): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // The desktop button and panel are drawn by the main window's page and have none of their own.
    if (!win.isDestroyed() && !isDesktopAgentWindow(win)) sendEvent(win.webContents, channel, ...args);
  }
}

let mainWindowFactory: (() => Promise<void>) | undefined;

/** index.ts registers the main window factory (mainWindow.ts) here on start-up, so `showMainWindow` can re-create a closed window. */
export function setMainWindowFactory(factory: () => Promise<void>): void {
  mainWindowFactory = factory;
}

/**
 * The main window while it is open. Never another window: the desktop button's windows stay
 * open while the main window is closed, and `getAllWindows()` makes no promise about order.
 */
export function getMainWindow(): BrowserWindow | undefined {
  const win = global.mainWindow;
  return win && !win.isDestroyed() ? win : undefined;
}

/**
 * Bring the main window forward, re-creating it if it was closed (macOS keeps the app running
 * with no window). Resolves to the window, or undefined before the app is ready.
 */
export async function showMainWindow(): Promise<BrowserWindow | undefined> {
  if (!app.isReady()) return undefined;
  const existing = getMainWindow();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  } else {
    await mainWindowFactory?.();
  }
  app.focus();
  return getMainWindow();
}
