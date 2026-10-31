import { app, autoUpdater, dialog } from 'electron';
import Store from 'electron-store';
import type { RunningWorkItem } from '../../../shared/types/updates';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../shared/assistantStackConstants';
import { handle } from '../../ipc';
import { persistDebugLog, serializeError } from '../../persistDebugLog';
import { codingFoldersBusy } from '../assistant/coding/codingGrants';
import { getHermesGatewaySession } from '../assistant/hermes/hermesGatewaySession';
import { getKanbanSnapshot } from '../assistant/hermes/hermesKanban';
import { listRunningTurns } from '../assistant/hermes/hermesRunningTurns';
import { broadcast } from '../windows';
import { decryptFromBase64, encryptToBase64 } from '../secrets/osEncryption';
import { compareVersions } from './updateFeed';
import {
  FeedKeyRejected,
  UpdateService,
  type FeedKey,
  type UpdateStore,
  type UpdateStoreShape,
} from './UpdateService';
import { APP_NAME } from '../../../shared/buildIdentity';

declare const __BOUNDARY_UPDATE_FEED_URL__: string | undefined;
declare const __BOUNDARY_UPDATE_KEY_REQUIRED__: boolean | undefined;

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

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers,
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) throw new FeedKeyRejected();
  if (!response.ok) throw new Error(`Feed returned ${response.status}`);
  return response.text();
}

function storedFeedKey(store: Store<UpdatesFileShape>): FeedKey {
  return {
    stored: () => Boolean(store.get('feedKey')),
    read: async () => {
      const encrypted = store.get('feedKey');
      if (!encrypted) return null;
      try {
        return await decryptFromBase64(encrypted, (next) => store.set('feedKey', next));
      } catch (error) {
        persistDebugLog('updates', 'update key unreadable', serializeError(error));
        return null;
      }
    },
    write: async (key) => store.set('feedKey', await encryptToBase64(key)),
  };
}

/** Chat titles by session id, for naming running chats. Empty when Hermes can't say. */
async function chatTitles(): Promise<Map<string, string>> {
  try {
    const sessions = await getHermesGatewaySession().listSessions();
    return new Map(sessions.map((session) => [session.id, session.title]));
  } catch (error) {
    persistDebugLog('updates', 'chat titles unavailable', serializeError(error));
    return new Map();
  }
}

async function runningWork(): Promise<RunningWorkItem[]> {
  const turns = listRunningTurns();
  const titles = turns.length > 0 ? await chatTitles() : new Map<string, string>();
  const items: RunningWorkItem[] = turns.map((turn) => ({
    id: `turn:${turn.requestId}`,
    kind: 'chat',
    title: turn.sessionIds.map((id) => titles.get(id)).find(Boolean) ?? 'A chat',
    detail: 'Your assistant is replying',
  }));
  for (const task of getKanbanSnapshot().tasks) {
    if (task.status === 'running') {
      items.push({ id: `task:${task.id}`, kind: 'task', title: task.title, detail: 'Board task' });
    }
  }
  try {
    const { sessions } = await codingFoldersBusy();
    for (const title of sessions) {
      items.push({ id: `coding:${title}`, kind: 'coding', title, detail: 'Coding job' });
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

export function registerUpdateHandlers(
  installAndRestart: () => void,
  onReadyChanged: () => void
): void {
  const store = new Store<UpdatesFileShape>({ name: 'updates' });
  let ready = false;
  settings = store;
  const updates = new UpdateService({
    currentVersion: app.getVersion(),
    stackVersion: SOVEREIGN_AGENT_STACK_VERSION,
    arch: process.arch,
    feedBase: buildFeedBase(),
    inApplications: () => app.isInApplicationsFolder(),
    fetchText,
    feedKey:
      typeof __BOUNDARY_UPDATE_KEY_REQUIRED__ === 'boolean' && __BOUNDARY_UPDATE_KEY_REQUIRED__
        ? storedFeedKey(store)
        : undefined,
    updater: autoUpdater,
    store: store as unknown as UpdateStore,
    runningWork,
    installAndRestart,
    onChange: (snapshot) => {
      broadcast('updates:state', snapshot);
      if ((snapshot.phase === 'ready') !== ready) {
        ready = snapshot.phase === 'ready';
        onReadyChanged();
      }
    },
    log: (message, details) => persistDebugLog('updates', message, details),
  });
  service = updates;

  handle('updates:get-state', () => updates.snapshot());
  handle('updates:check', () => updates.check({ manual: true }));
  handle('updates:download', () => updates.download());
  handle('updates:restart', (_event, options) => updates.restart(options));
  handle('updates:restart-when-finished', (_event, items) => updates.restartWhenFinished(items));
  handle('updates:cancel-waiting', () => updates.cancelWaiting());
  handle('updates:close-card', () => updates.closeCard());
  handle('updates:close-updated', () => updates.closeUpdated());
  handle('updates:skip-version', () => updates.skipVersion());
  handle('updates:set-channel', (_event, channel) => updates.setChannel(channel));
  handle('updates:set-checks-enabled', (_event, enabled) => updates.setChecksEnabled(enabled));
  handle('updates:set-feed-key', (_event, key) => updates.setFeedKey(key));
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
    message: `Move ${APP_NAME} to Applications?`,
    detail: `${APP_NAME} can update itself only from the Applications folder.`,
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

/** The Boundary menu's update item. The renderer runs the running-work check for a restart. */
export function updateMenuItem(): { label: string; click: () => void } {
  if (service?.snapshot().phase === 'ready') {
    return { label: 'Restart to Update…', click: () => broadcast('updates:restart-requested') };
  }
  return {
    label: 'Check for Updates…',
    click: () => {
      void service?.check({ manual: true });
      broadcast('updates:open');
    },
  };
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
