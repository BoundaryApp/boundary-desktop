import { app, nativeImage, type NativeImage } from 'electron';
import { parseAppBadge, type AppBadge } from '../shared/appBadge';
import { handle } from './ipc';
import { persistDebugLog } from './persistDebugLog';
import { getMainWindow } from './services/windows';

/**
 * The `.desktop` file the deb and rpm makers install. electron-installer-common names it after
 * package.json's `name`; Electron's own fallback would be a slug of the app name
 * (`boundary.desktop`), which matches no installed file, so Linux docks would drop the badge.
 */
export const LINUX_DESKTOP_NAME = 'boundary-desktop.desktop';

/** Point Linux desktop integration at the installed `.desktop` file. Call before `ready`. */
export function setLinuxDesktopName(): void {
  if (process.platform === 'linux') app.setDesktopName(LINUX_DESKTOP_NAME);
}

interface OverlayWindow {
  isDestroyed(): boolean;
  setOverlayIcon(overlay: NativeImage | null, description: string): void;
}

/** What applying a badge touches, so tests can stand in for Electron. */
export interface AppBadgeTarget {
  platform: NodeJS.Platform;
  setBadgeCount(count: number): boolean;
  window(): OverlayWindow | undefined;
  image(dataUrl: string): NativeImage;
  log(event: string, data: Record<string, unknown>): void;
}

const electronTarget = (): AppBadgeTarget => ({
  platform: process.platform,
  setBadgeCount: (count) => app.setBadgeCount(count),
  window: getMainWindow,
  image: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
  log: (event, data) => persistDebugLog('app-badge', event, data),
});

let refusalLogged = false;

/**
 * Show `badge` on the app's icon. macOS and Linux get a count badge. Windows has none, so its
 * taskbar button gets the renderer's overlay image, or loses the overlay at 0.
 */
export function applyAppBadge(badge: AppBadge, target: AppBadgeTarget = electronTarget()): void {
  if (target.platform === 'win32') {
    const win = target.window();
    if (!win || win.isDestroyed()) return;
    const image = badge.count > 0 && badge.overlay ? target.image(badge.overlay) : null;
    if (image && !image.isEmpty()) win.setOverlayIcon(image, `${badge.count} unread`);
    else win.setOverlayIcon(null, '');
    return;
  }
  if (target.platform !== 'darwin' && target.platform !== 'linux') return;
  // false on macOS when notifications are off for the app, and on Linux docks without the API.
  if (!target.setBadgeCount(badge.count) && !refusalLogged) {
    refusalLogged = true;
    target.log('badge not shown', { platform: target.platform });
  }
}

/** Test hook: let the next refusal log again. */
export function resetAppBadgeLogForTests(): void {
  refusalLogged = false;
}

export function registerAppBadgeHandlers(): void {
  handle('app-badge:set', (_event, input: unknown) => {
    const badge = parseAppBadge(input);
    if (badge) applyAppBadge(badge);
  });
}
