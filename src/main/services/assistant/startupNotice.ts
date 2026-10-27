import { app, BrowserWindow } from 'electron';
import { showWindowNotification } from '../notifications';
import { describeStartupError } from '../../../shared/startupErrors';
import type { AssistantStackLifecycleSnapshot } from '../../../shared/types/assistantStack';

/**
 * Tells the user when a long start-up finishes while Boundary is in the
 * background (ADR 0029). First run takes minutes, so people switch away.
 */

/** Starts shorter than this end before anyone has switched away; no notice. */
export const STARTUP_NOTICE_MIN_MS = 15_000;

export interface StartupNotice {
  title: string;
  body: string;
}

function startupNoticeFor(
  prev: AssistantStackLifecycleSnapshot['phase'],
  next: AssistantStackLifecycleSnapshot,
  elapsedMs: number
): StartupNotice | null {
  if (prev !== 'starting' || elapsedMs < STARTUP_NOTICE_MIN_MS) return null;
  if (next.phase === 'ready') {
    return { title: 'Your assistant is ready', body: 'Your tools are running. Open Boundary to start chatting.' };
  }
  if (next.phase === 'error') {
    const failure = describeStartupError(next.error ?? next.message);
    return { title: 'Your assistant didn’t start', body: failure.title };
  }
  return null;
}

export interface StartupNoticeDeps {
  now: () => number;
  inBackground: () => boolean;
  notify: (notice: StartupNotice) => void;
}

function showStartupNotification(notice: StartupNotice): void {
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  showWindowNotification(notice);
}

const defaultDeps: StartupNoticeDeps = {
  now: () => Date.now(),
  inBackground: () => BrowserWindow.getAllWindows().every((w) => w.isDestroyed() || !w.isFocused()),
  notify: showStartupNotification,
};

/** Returns a lifecycle listener that notifies on a long start's ready or error. */
export function createStartupNotifier(
  deps: StartupNoticeDeps = defaultDeps
): (snapshot: AssistantStackLifecycleSnapshot) => void {
  let phase: AssistantStackLifecycleSnapshot['phase'] = 'idle';
  let startedAt = 0;
  return (snapshot) => {
    if (snapshot.phase === 'starting' && phase !== 'starting') startedAt = deps.now();
    const notice = startupNoticeFor(phase, snapshot, deps.now() - startedAt);
    phase = snapshot.phase;
    if (notice && deps.inBackground()) deps.notify(notice);
  };
}
