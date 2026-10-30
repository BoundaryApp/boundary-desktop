import { app, autoUpdater, dialog } from 'electron';
import Store from 'electron-store';
import type { RunningWorkItem } from '../../../shared/types/updates';
import { handle } from '../../ipc';
import { persistDebugLog, serializeError } from '../../persistDebugLog';
import { codingFoldersBusy } from '../assistant/coding/codingGrants';
import { getKanbanSnapshot } from '../assistant/hermes/hermesKanban';
import { listRunningTurns } from '../assistant/hermes/hermesRunningTurns';
import { broadcast } from '../windows';
import { compareVersions } from './updateFeed';
import { UpdateService, type UpdateStore, type UpdateStoreShape } from './UpdateService';

declare const __BOUNDARY_UPDATE_FEED_URL__: string | undefined;

const FEED_TIMEOUT_MS = 15_000;

interface UpdatesFileShape extends UpdateStoreShape {
  moveToApplicationsOffered?: boolean;
}

let service: UpdateService | null = null;
let settings: Store<UpdatesFileShape> | null = null;

function buildFeedBase(): string {
  if (!app.isPackaged || process.platform !== 'darwin') return '';
  return typeof __BOUNDARY_UPDATE_FEED_URL__ === 'string' ? __BOUNDARY_UPDATE_FEED_URL__ : '';
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Feed returned ${response.status}`);
  return response.text();
}

async function runningWork(): Promise<RunningWorkItem[]> {
  const items: RunningWorkItem[] = listRunningTurns().map((turn) => ({
    id: `turn:${turn.requestId}`,
    title: 'A chat',
    detail: 'Your assistant is replying',
  }));
  for (const task of getKanbanSnapshot().tasks) {
    if (task.status === 'running') {
      items.push({ id: `task:${task.id}`, title: task.title, detail: 'Board task' });
    }
  }
  try {
    const { sessions } = await codingFoldersBusy();
    for (const title of sessions) {
      items.push({ id: `coding:${title}`, title, detail: 'Coding job' });
    }
  } catch (error) {
    persistDebugLog('updates', 'coding busy check failed', serializeError(error));
  }
  return items;
}

/** Hand over to Squirrel. If it refuses, quit normally: the stack has already stopped. */
export function quitAndInstallUpdate(): void {
  try {
    autoUpdater.quitAndInstall();
  } catch (error) {
    persistDebugLog('updates', 'quitAndInstall failed', serializeError(error));
    app.exit(0);
  }
}

export function registerUpdateHandlers(installAndRestart: () => void): void {
  const store = new Store<UpdatesFileShape>({ name: 'updates' });
  settings = store;
  const updates = new UpdateService({
    currentVersion: app.getVersion(),
    arch: process.arch,
    feedBase: buildFeedBase(),
    inApplications: () => app.isInApplicationsFolder(),
    fetchText,
    updater: autoUpdater,
    store: store as unknown as UpdateStore,
    runningWork,
    installAndRestart,
    onChange: (snapshot) => broadcast('updates:state', snapshot),
    log: (message, details) => persistDebugLog('updates', message, details),
  });
  service = updates;

  handle('updates:get-state', () => updates.snapshot());
  handle('updates:check', () => updates.check({ manual: true }));
  handle('updates:download', () => updates.download());
  handle('updates:restart', (_event, options) => updates.restart(options));
  handle('updates:restart-when-finished', (_event, items) => updates.restartWhenFinished(items));
  handle('updates:cancel-waiting', () => updates.cancelWaiting());
  handle('updates:close-notice', () => updates.closeNotice());
  handle('updates:skip-version', () => updates.skipVersion());
  handle('updates:page-seen', () => updates.markPageSeen());
  handle('updates:set-channel', (_event, channel) => updates.setChannel(channel));
  handle('updates:set-checks-enabled', (_event, enabled) => updates.setChecksEnabled(enabled));
  handle('updates:move-to-applications', () => {
    app.moveToApplicationsFolder();
  });
}

/** Squirrel can't update an app run from the DMG or Downloads, so offer the move once. */
async function offerMoveToApplications(): Promise<void> {
  if (settings?.get('moveToApplicationsOffered')) return;
  settings?.set('moveToApplicationsOffered', true);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Move Boundary to Applications?',
    detail: 'Boundary can update itself only from the Applications folder.',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) app.moveToApplicationsFolder();
}

export async function startUpdates(): Promise<void> {
  if (!service) return;
  if (service.snapshot().blocked === 'not-in-applications') {
    await offerMoveToApplications().catch((error: unknown) => {
      persistDebugLog('updates', 'move to Applications failed', serializeError(error));
    });
  }
  service.start();
}

export function checkForUpdatesFromMenu(): void {
  void service?.check({ manual: true });
  broadcast('updates:open');
}

/**
 * Record the highest version that has opened this data, so a later build can refuse to run on
 * data newer than it understands. A version that was never recorded can't be checked.
 */
export function recordDataVersion(
  store: { get: (key: 'dataVersion') => unknown; set: (key: 'dataVersion', value: string) => void },
  version: string
): void {
  const recorded = store.get('dataVersion');
  if (typeof recorded !== 'string' || (compareVersions(version, recorded) ?? 0) > 0) {
    store.set('dataVersion', version);
  }
}
