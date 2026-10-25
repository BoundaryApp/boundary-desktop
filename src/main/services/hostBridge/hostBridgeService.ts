import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, Notification, shell, utilityProcess, type UtilityProcess } from 'electron';
import { createFileLogger } from '../../../shared/utils/logger';
import { persistDebugLog } from '../../persistDebugLog';
import { denyAllHostBridgeApprovals, requestHostBridgeApproval, setHostBridgeApprovalSender } from './approvals';
import { appendAudit, trimForAudit } from './auditLog';
import type { BridgeToMain, HostToolListing, MainToBridge } from './bridgeMessages';
import { hasCalendarAccounts } from '../assistant/calendar/calendarStore';
import type { BoundaryBrowserState, HostToolsState } from '../../../shared/types/hostBridge';
import { browserRelayConfigFrom, findGoogleChrome, normalizeBrowserSettings, sitePolicyFrom } from './browserConfig';
import { DEFAULT_BLOCKED_SITES } from './cdpPolicy';
import {
  addHostBridgeGrant,
  ensureHostBridgeToken,
  getHostBridgeBrowserSettings,
  getExpectedHermesClients,
  getHostBridgePorts,
  hasHostBridgeGrant,
  setExpectedHermesClients,
  setHostBridgeBrowserSettings,
  setHostBridgePorts,
  type HostBridgeBrowserSettings,
} from './hostBridgeStore';
import { executeHostTool, type HostToolDeps } from './hostTools';
import { HOST_TOOLS_SETTLE_MS, HOST_TOOLS_WAKE_SETTLE_MS, hostToolsStateFor, nextExpectedClients } from './hostToolsState';

/**
 * Runs the host bridge (ADR 0027): forks the utilityProcess that owns the loopback listeners,
 * hands it the tokens and preferred ports, and answers its tool calls. Main stays the authority
 * for grants, approvals and the audit log.
 */

const log = createFileLogger(import.meta.url);

export interface HostBridgeEndpoints {
  mcpPort: number;
  browserPort: number;
  mcpToken: string;
  browserToken: string;
}

/** Bundled next to the main bundle as `hostBridge.js` (vite.hostBridge.config.ts). */
const BRIDGE_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hostBridge.js');
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 2_000;
const MAX_RESTARTS = 3;

let child: UtilityProcess | null = null;
let ready: Promise<HostBridgeEndpoints> | null = null;
let stopping = false;
/** Set for good once Boundary starts quitting: nothing may start the bridge after that. */
let quitting = false;
let restarts = 0;
let hostToolsState: HostToolsState = 'off';
/**
 * This launch of the bridge: when it came up, how many Hermes clients to wait for (from the last
 * launch), and how many have listed the tools so far.
 */
let bridgeRun: {
  expected: number;
  clients: number;
  settled: boolean;
  settleAt: number;
  settle: NodeJS.Timeout | null;
} | null = null;

/** Replies the bridge owes main, by request id (browser open / status). */
let nextRequestId = 1;
const pendingRequests = new Map<number, (message: BridgeToMain) => void>();

const liveNotifications = new Set<Notification>();
const NOTIFICATION_RETAIN_MS = 10 * 60_000;
const NOTIFICATION_CONFIRM_MS = 5_000;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** Bring Boundary forward so a native dialog isn't hidden behind another app. */
function dialogParent(): BrowserWindow | null {
  const win = global.mainWindow && !global.mainWindow.isDestroyed() ? global.mainWindow : BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return null;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

const toolDeps: HostToolDeps = {
  hasGrant: (capability, resource) => hasHostBridgeGrant(capability, resource),
  addGrant: (capability, resource, expiresAt) => addHostBridgeGrant(capability, resource, expiresAt ?? null),
  requestApproval: (request) => requestHostBridgeApproval(request),
  showNotification: (title, body) =>
    new Promise((resolve, reject) => {
      if (!Notification.isSupported()) {
        reject(new Error('Notifications are not supported on this system.'));
        return;
      }
      // Held until closed (or ten minutes): an unreferenced Notification can be collected
      // before macOS shows it, and the call still looks successful.
      const notification = new Notification({ title, body });
      liveNotifications.add(notification);
      const release = () => liveNotifications.delete(notification);
      notification.once('close', release);
      setTimeout(release, NOTIFICATION_RETAIN_MS).unref();
      const unconfirmed = setTimeout(() => resolve('unconfirmed'), NOTIFICATION_CONFIRM_MS);
      notification.once('show', () => {
        clearTimeout(unconfirmed);
        resolve('shown');
      });
      notification.once('failed', (_event, error) => {
        clearTimeout(unconfirmed);
        release();
        reject(new Error(error));
      });
      notification.show();
    }),
  openExternal: (url) => shell.openExternal(url),
  readClipboard: () => clipboard.readText(),
  writeClipboard: (text) => clipboard.writeText(text),
  pickFiles: async ({ message, multiple, extensions }) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose files for Hermes',
      message,
      buttonLabel: 'Give to Hermes',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      ...(extensions.length ? { filters: [{ name: extensions.join(', '), extensions }] } : {}),
    };
    const parent = dialogParent();
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  },
  chooseSavePath: async ({ defaultName }) => {
    const options: Electron.SaveDialogOptions = {
      title: 'Save a file from Hermes',
      message: 'Hermes wants to save this file. Choose where, or cancel.',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      buttonLabel: 'Save',
    };
    const parent = dialogParent();
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    return result.canceled || !result.filePath ? null : result.filePath;
  },
  fileSize: async (filePath) => {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  },
  readFile: (filePath) => fs.promises.readFile(filePath),
  writeFile: (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8'),
  now: () => Date.now(),
  calendarConnected: () => hasCalendarAccounts(),
  audit: (entry) => appendAudit({ ...entry, args: trimForAudit(entry.args) }),
};

function setHostToolsState(next: HostToolsState): void {
  if (next === hostToolsState) return;
  hostToolsState = next;
  persistDebugLog('host-bridge', 'host tools state', { state: next });
  broadcast('host-bridge:tools-state', next);
}

function updateHermesClients(): void {
  if (!bridgeRun) return;
  const stored = getExpectedHermesClients();
  const next = nextExpectedClients(stored, bridgeRun.clients, bridgeRun.settled);
  if (next !== stored) setExpectedHermesClients(next);
  setHostToolsState(hostToolsStateFor(bridgeRun.clients, bridgeRun.expected, bridgeRun.settled));
}

function scheduleSettle(delayMs: number): void {
  if (!bridgeRun) return;
  const run = bridgeRun;
  if (run.settle) clearTimeout(run.settle);
  run.settleAt = Date.now() + delayMs;
  run.settle = setTimeout(() => {
    run.settled = true;
    updateHermesClients();
  }, delayMs);
  run.settle.unref?.();
}

/**
 * The stack accepted a wake for the bridge (ADR 0027), so stop waiting on Hermes's slow parked
 * retry: settle shortly unless already due sooner.
 */
export function hostBridgeWakeAccepted(): void {
  if (!bridgeRun || bridgeRun.settled) return;
  if (bridgeRun.settleAt > Date.now() + HOST_TOOLS_WAKE_SETTLE_MS) scheduleSettle(HOST_TOOLS_WAKE_SETTLE_MS);
}

function beginBridgeRun(): void {
  endBridgeRun();
  bridgeRun = {
    expected: getExpectedHermesClients(),
    clients: 0,
    settled: false,
    settleAt: 0,
    settle: null,
  };
  scheduleSettle(HOST_TOOLS_SETTLE_MS);
  updateHermesClients();
}

function endBridgeRun(): void {
  if (bridgeRun?.settle) clearTimeout(bridgeRun.settle);
  bridgeRun = null;
}

/** Whether Hermes can use the host tools now; the chat says so while it can't. */
export function getHostToolsState(): HostToolsState {
  return hostToolsState;
}

function post(target: UtilityProcess, message: MainToBridge): void {
  target.postMessage(message);
}

async function launch(): Promise<HostBridgeEndpoints> {
  setHostBridgeApprovalSender(broadcast);
  const mcpToken = await ensureHostBridgeToken('mcp');
  const browserToken = await ensureHostBridgeToken('browser');
  // Reading the tokens waits on the keychain; Boundary may have started quitting meanwhile.
  if (quitting) throw new Error('Boundary is quitting.');
  const preferred = getHostBridgePorts();

  const proc = utilityProcess.fork(BRIDGE_ENTRY, [], { serviceName: 'Boundary Host Bridge' });
  child = proc;

  return new Promise<HostBridgeEndpoints>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host bridge did not start in time.')), START_TIMEOUT_MS);

    proc.on('message', (message: BridgeToMain) => {
      switch (message.type) {
        case 'ready':
          clearTimeout(timer);
          setHostBridgePorts({ mcp: message.mcpPort, browser: message.browserPort });
          persistDebugLog('host-bridge', 'ready', { mcpPort: message.mcpPort, browserPort: message.browserPort });
          beginBridgeRun();
          resolve({ mcpPort: message.mcpPort, browserPort: message.browserPort, mcpToken, browserToken });
          return;
        case 'hermes-clients':
          if (child === proc && bridgeRun) {
            bridgeRun.clients = message.count;
            persistDebugLog('host-bridge', 'hermes clients', { count: message.count, expected: bridgeRun.expected });
            updateHermesClients();
          }
          return;
        case 'start-failed':
          clearTimeout(timer);
          reject(new Error(`Host bridge failed to start: ${message.error}`));
          return;
        case 'tool-call':
          void executeHostTool(message.name, message.args, toolDeps).then((result) => {
            if (child === proc) post(proc, { type: 'tool-result', id: message.id, result });
          });
          return;
        case 'browser-open-result':
        case 'browser-status-result': {
          const resolveRequest = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          resolveRequest?.(message);
          return;
        }
        case 'log':
          persistDebugLog('host-bridge', message.message, message.data ?? {});
          return;
        case 'stopped':
          return;
      }
    });

    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (child === proc) {
        child = null;
        ready = null;
        endBridgeRun();
        setHostToolsState('off');
      }
      denyAllHostBridgeApprovals();
      if (stopping) return;
      log('host bridge exited unexpectedly', { code });
      persistDebugLog('host-bridge', 'exited unexpectedly', { code, restarts });
      reject(new Error(`Host bridge exited (code ${code}).`));
      if (restarts < MAX_RESTARTS) {
        restarts += 1;
        setTimeout(() => void ensureHostBridgeStarted().catch(() => {
          /* logged in ensureHostBridgeStarted */
        }), 1_000 * restarts).unref();
      }
    });

    post(proc, {
      type: 'start',
      mcpToken,
      browserToken,
      mcpPort: preferred.mcp,
      browserPort: preferred.browser,
      browser: browserRelayConfigFrom(getHostBridgeBrowserSettings()),
      listing: hostToolListing(),
    });
  });
}

function hostToolListing(): HostToolListing {
  return { offerCalendarSetup: !hasCalendarAccounts() };
}

/**
 * Bring the running bridge's tool list in line with the calendars. Call it before the
 * `reload.mcp` that follows a connect or removal: Hermes lists the tools again as it reconnects.
 */
export function syncHostToolListing(): void {
  if (child) post(child, { type: 'tool-listing', listing: hostToolListing() });
}

/** Start the bridge once; later calls share the same startup. */
export function ensureHostBridgeStarted(): Promise<HostBridgeEndpoints> {
  if (quitting) return Promise.reject(new Error('Boundary is quitting.'));
  if (!ready) {
    stopping = false;
    ready = launch();
    ready.catch((err: unknown) => {
      log('host bridge start failed', err);
      persistDebugLog('host-bridge', 'start failed', { error: err instanceof Error ? err.message : String(err) });
      ready = null;
    });
  }
  return ready;
}

/** Stop the bridge for good (Boundary is quitting). */
export async function stopHostBridge(): Promise<void> {
  stopping = true;
  quitting = true;
  denyAllHostBridgeApprovals();
  const proc = child;
  child = null;
  ready = null;
  endBridgeRun();
  setHostToolsState('off');
  if (!proc) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill();
      resolve();
    }, STOP_TIMEOUT_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    post(proc, { type: 'stop' });
  });
}

/**
 * Ask the bridge something and wait for its answer. Only `start: true` may start a bridge that
 * isn't running; a status poll must never (it once relaunched the bridge mid-quit).
 */
async function requestBridge<T extends BridgeToMain>(
  build: (id: number) => MainToBridge,
  timeoutMs: number,
  { start }: { start: boolean }
): Promise<T> {
  if (start) await ensureHostBridgeStarted();
  const proc = child;
  if (!proc) throw new Error('The host bridge is not running.');
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('The host bridge did not answer.'));
    }, timeoutMs);
    pendingRequests.set(id, (message) => {
      clearTimeout(timer);
      resolve(message as T);
    });
    post(proc, build(id));
  });
}

export async function getBoundaryBrowserState(): Promise<BoundaryBrowserState> {
  const settings = getHostBridgeBrowserSettings();
  const base = {
    settings,
    effectiveBlocked: sitePolicyFrom(settings).blocked,
    defaultBlocked: [...DEFAULT_BLOCKED_SITES],
    chromeInstalled: Boolean(findGoogleChrome()),
  };
  try {
    const status = await requestBridge<Extract<BridgeToMain, { type: 'browser-status-result' }>>(
      (id) => ({ type: 'browser-status', id }),
      5_000,
      { start: false }
    );
    return { ...base, running: status.running, clients: status.clients };
  } catch {
    return { ...base, running: false, clients: 0 };
  }
}

/** Save the settings and apply them to the running bridge. Hermes's own config is the caller's job. */
export async function updateBoundaryBrowserSettings(next: HostBridgeBrowserSettings): Promise<HostBridgeBrowserSettings> {
  const settings = normalizeBrowserSettings(next);
  setHostBridgeBrowserSettings(settings);
  if (child) post(child, { type: 'browser-config', browser: browserRelayConfigFrom(settings) });
  return settings;
}

/** Start Boundary's Chrome (if needed) and show a window, so the user can sign in to sites. */
export async function openBoundaryBrowser(): Promise<void> {
  const reply = await requestBridge<Extract<BridgeToMain, { type: 'browser-open-result' }>>(
    (id) => ({ type: 'browser-open', id }),
    30_000,
    { start: true }
  );
  if (reply.error) throw new Error(reply.error);
}
