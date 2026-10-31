import { execFileSync } from 'node:child_process';
import { dialog, type App } from 'electron';
import { APP_ID, APP_NAME } from '../shared/buildIdentity';
import { persistDebugLog, serializeError } from './persistDebugLog';

const FAMILY_ID = 'com.boundary.desktop';
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * The name of the first foreground app in `lsappinfo list` output from this app's bundle ID
 * family, other than this build. Foreground rules out helpers and the updater, whose IDs extend
 * the app's own.
 */
export function siblingBuildName(listing: string, ownId: string): string | null {
  for (const entry of listing.split(/^\s*\d+\) /m)) {
    const id = /bundleID="([^"]+)"/.exec(entry)?.[1];
    if (!id || id === ownId) continue;
    if (id !== FAMILY_ID && !id.startsWith(`${FAMILY_ID}.`)) continue;
    if (!/\btype="Foreground"/.test(entry)) continue;
    const name = /^"([^"]+)"/.exec(entry)?.[1];
    if (name) return name;
  }
  return null;
}

/**
 * Another build of this app that is running now, by the name macOS reports. Two builds would
 * compete for the one VM Podman runs at a time. A failed lookup lets this build start.
 */
export function findRunningSibling(run: () => string = listRunningApps): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    return siblingBuildName(run(), APP_ID);
  } catch (error) {
    persistDebugLog('startup', 'sibling build lookup failed', serializeError(error));
    return null;
  }
}

function listRunningApps(): string {
  return execFileSync('/usr/bin/lsappinfo', ['list'], {
    encoding: 'utf8',
    timeout: LOOKUP_TIMEOUT_MS,
  });
}

/** Tell the user why this build won't open, then exit. Call once the app is ready. */
export async function refuseToStart(app: Pick<App, 'exit'>, sibling: string): Promise<void> {
  persistDebugLog('startup', 'another build is running; exiting', {});
  await dialog.showMessageBox({
    type: 'info',
    message: `${sibling} is already running`,
    detail: `Quit ${sibling}, then open ${APP_NAME}.`,
    buttons: ['OK'],
  });
  // exit, not quit: this copy started nothing for before-quit to stop.
  app.exit(0);
}
