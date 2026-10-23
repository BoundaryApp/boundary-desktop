import type { App } from 'electron';
import { persistDebugLog } from './persistDebugLog';

/**
 * Take the single-instance lock. A second copy would run the stack's launch and compose
 * against the same project and Podman machine as the first, so it exits and the first
 * instance shows its window instead.
 *
 * Returns false in the second copy, which is already exiting.
 */
export function claimSingleInstance(
  app: Pick<App, 'requestSingleInstanceLock' | 'on' | 'exit'>,
  onSecondInstance: () => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    persistDebugLog('startup', 'another Boundary instance holds the lock; exiting', {});
    // exit, not quit: quit runs before-quit, which would stop the first instance's stack.
    app.exit(0);
    return false;
  }
  app.on('second-instance', () => {
    persistDebugLog('startup', 'second-instance', {});
    onSecondInstance();
  });
  return true;
}
