import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, type BrowserWindow, clipboard, dialog, Notification, shell, utilityProcess, type UtilityProcess } from 'electron';
import { broadcast, showMainWindow } from '../windows';
import { createFileLogger } from '../../../shared/utils/logger';
import { persistDebugLog } from '../../persistDebugLog';
import { denyAllHostBridgeApprovals, requestHostBridgeApproval, setHostBridgeApprovalSender } from './approvals';
import { appendAudit, trimForAudit } from './auditLog';
import type { BridgeToMain, HostToolListing, MainToBridge } from './bridgeMessages';
import { getMacCalendarAccount, hasCalendarAccounts } from '../assistant/calendar/calendarStore';
import { callMacCalendarTool, listMacCalendarTools, MAC_CHANGE_TOOLS, MAC_READ_TOOLS } from '../assistant/calendar/macCalendarTools';
import { getMacCalendarHelper } from '../assistant/calendar/macCalendarHelper';
import type { ToolCallResult } from './mcpProtocol';
import type { BoundaryBrowserState, HostToolsState } from '../../../shared/types/hostBridge';
import type { IpcResult } from '../../../shared/ipc/result';
import { browserRelayConfigFrom, findGoogleChrome, normalizeBrowserSettings, sitePolicyFrom } from './browserConfig';
import { DEFAULT_BLOCKED_SITES } from './cdpPolicy';
import {
  credentialClientUrl,
  CredentialTokens,
  removeCredentialClientFiles,
  writeCredentialClientFiles,
} from './credentialClient';
import { heldNotification } from '../notifications';
import {
  addHostBridgeGrant,
  ensureHostBridgeToken,
  getHostBridgeBrowserSettings,
  getExpectedHermesClients,
  getHostBridgePorts,
  hasHostBridgeGrant,
  isHostBridgeAgentStopped,
  rotateHostBridgeTokens,
  setExpectedHermesClients,
  setHostBridgeAgentStopped,
  setHostBridgeBrowserSettings,
  setHostBridgePorts,
  type HostBridgeBrowserSettings,
} from './hostBridgeStore';
import { agentAppAccessEnabled } from './agentAppAccess';
import { executeHostTool, notificationFailureMessage, type AgentAppSource, type HostToolDeps } from './hostTools';
import { dialogStartFolder, rememberDialogPick } from '../dialogFolders';
import { stopUtilityProcess } from '../stopUtilityProcess';
import {
  HERMES_SESSION_IDLE_MS,
  HOST_TOOLS_SETTLE_MS,
  HOST_TOOLS_WAKE_SETTLE_MS,
  hostToolsStateFor,
  nextExpectedClients,
} from './hostToolsState';
import { APP_NAME } from '../../../shared/buildIdentity';
import { StackCapabilityMissing, hasStackCapability } from '../stackHost/capabilities';

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
const AGENT_STOPPED_MESSAGE =
  'Computer access is stopped. Turn it back on in Settings → Computer access.';
/** A bridge that ran this long before exiting was healthy: its exit starts the restart count over. */
const HEALTHY_RUN_MS = 60_000;

let child: UtilityProcess | null = null;
let ready: Promise<HostBridgeEndpoints> | null = null;
let stopping = false;
/** Set for good once Boundary starts quitting: nothing may start the bridge after that. */
let quitting = false;
let restarts = 0;
let hostToolsState: HostToolsState = 'off';
/**
 * This launch of the bridge: when it came up, how many Hermes clients to wait for (from the last
 * launch), how many are connected now, and the most that have been at once. The state uses the
 * peak, so a client that re-initializes doesn't send the chat back to "waiting".
 */
let bridgeRun: {
  expected: number;
  clients: number;
  peak: number;
  settled: boolean;
  settleAt: number;
  settle: NodeJS.Timeout | null;
} | null = null;

/** Calendar token → agent slug, kept here so a restarted bridge gets it too. */
let calendarTokens: Record<string, string> = {};

/**
 * The relay's credential client (ADR 0065): its token for this run of the bridge, the port its
 * endpoint names, and where its two files go (the Bitwarden add-on's `secrets` folder, or null
 * with no stack). Writes run one after another, so a removal never lands after a later write.
 */
let credentialTokens: CredentialTokens | null = null;
let credentialPort: number | null = null;
let credentialFolder: () => Promise<string | null> = async () => null;
let credentialWrites: Promise<void> = Promise.resolve();

/** Set at registration: the folder comes from the stack's settings, which import this module. */
export function setCredentialClientFolder(resolve: () => Promise<string | null>): void {
  credentialFolder = resolve;
}

/**
 * Bring the two files in line with the bridge: its endpoint and current token while it runs,
 * nothing while it doesn't. Nothing is written when the add-on's folder doesn't exist. The log
 * names the outcome and the port, never a value. Never throws.
 */
function syncCredentialFiles(reason: string): Promise<void> {
  const token = credentialTokens?.current ?? null;
  const port = credentialPort;
  credentialWrites = credentialWrites
    .then(async () => {
      const dir = await credentialFolder();
      if (!dir) return;
      if (!token || port === null) {
        await removeCredentialClientFiles(dir);
        persistDebugLog('host-bridge', 'credential client files removed', { reason });
        return;
      }
      const result = await writeCredentialClientFiles(dir, { url: credentialClientUrl(port), token });
      persistDebugLog('host-bridge', 'credential client files', { reason, result, port });
    })
    .catch((err: unknown) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      persistDebugLog('host-bridge', 'credential client files not written', {
        reason,
        error: code ?? (err instanceof Error ? err.name : 'unknown'),
      });
    });
  return credentialWrites;
}

/** Write the files again, as after the add-on's folders are made or the stack is applied. */
export function refreshCredentialClientFiles(): Promise<void> {
  return syncCredentialFiles('refresh');
}

/** The credential tokens the running bridge accepts, for masking a report. */
export async function currentCredentialClientTokens(): Promise<string[]> {
  return credentialTokens?.accepted ?? [];
}

/** The bridge is gone: its credential token stops being accepted, so its files go too. */
function endCredentialClient(reason: string): Promise<void> {
  credentialTokens?.stop();
  credentialTokens = null;
  credentialPort = null;
  return syncCredentialFiles(reason);
}

/** Replies the bridge owes main, by request id (browser open / status). */
let nextRequestId = 1;
const pendingRequests = new Map<number, { resolve: (message: BridgeToMain) => void; reject: (err: Error) => void }>();

const NOTIFICATION_CONFIRM_MS = 5_000;

/**
 * Bring the main window forward, re-opening it if it was closed, so a native dialog isn't
 * hidden behind another app.
 */
async function dialogParent(): Promise<BrowserWindow | null> {
  return (await showMainWindow()) ?? null;
}

/** Set at registration: the source reads services that import this module. */
let agentAppSource: AgentAppSource = {
  check: async () => ({ ok: false, reason: "This tool isn't available yet." }),
  status: async () => ({}),
  problems: () => [],
};

export function setAgentAppSource(source: AgentAppSource): void {
  agentAppSource = source;
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
      const { notification, release } = heldNotification({ title, body });
      const unconfirmed = setTimeout(() => resolve('unconfirmed'), NOTIFICATION_CONFIRM_MS);
      notification.once('show', () => {
        clearTimeout(unconfirmed);
        resolve('shown');
      });
      notification.once('failed', (_event, error) => {
        clearTimeout(unconfirmed);
        release();
        // A dev build runs as Electron.app, which is the name System Settings shows.
        reject(new Error(notificationFailureMessage(error, app.isPackaged ? app.getName() : 'Electron')));
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
      defaultPath: dialogStartFolder(),
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      ...(extensions.length ? { filters: [{ name: extensions.join(', '), extensions }] } : {}),
    };
    const parent = await dialogParent();
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    rememberDialogPick(result.filePaths[0]);
    return result.filePaths;
  },
  chooseSavePath: async ({ defaultName }) => {
    const options: Electron.SaveDialogOptions = {
      title: 'Save a file from Hermes',
      message: 'Hermes wants to save this file. Choose where, or cancel.',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      buttonLabel: 'Save',
    };
    const parent = await dialogParent();
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    rememberDialogPick(result.filePath);
    return result.filePath;
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
  agentApp: {
    check: () => agentAppSource.check(),
    status: () => agentAppSource.status(),
    problems: () => agentAppSource.problems(),
  },
  audit: (entry) => appendAudit({ ...entry, args: trimForAudit(entry.args) }),
};

/** What the chat sees while no bridge runs: `stopped` after Stop agent, so it points to the setting. */
function idleHostToolsState(): HostToolsState {
  return isHostBridgeAgentStopped() ? 'stopped' : 'off';
}

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
  setHostToolsState(hostToolsStateFor(bridgeRun.peak, bridgeRun.expected, bridgeRun.settled));
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
  if (!bridgeRun.settle || bridgeRun.settleAt > Date.now() + HOST_TOOLS_WAKE_SETTLE_MS) {
    scheduleSettle(HOST_TOOLS_WAKE_SETTLE_MS);
  }
}

function beginBridgeRun(): void {
  endBridgeRun();
  bridgeRun = {
    expected: getExpectedHermesClients(),
    clients: 0,
    peak: 0,
    settled: false,
    settleAt: 0,
    settle: null,
  };
  updateHermesClients();
}

function endBridgeRun(): void {
  if (bridgeRun?.settle) clearTimeout(bridgeRun.settle);
  bridgeRun = null;
}

/** Whether Hermes can use the host tools now; the chat says so while it can't. */
export function getHostToolsState(): HostToolsState {
  // A launch with access stopped never starts a bridge, so nothing has set `stopped` yet. Record
  // it here, so turning access back on is a change the window that read it gets told about.
  if (hostToolsState === 'off') hostToolsState = idleHostToolsState();
  return hostToolsState;
}

function post(target: UtilityProcess, message: MainToBridge): void {
  target.postMessage(message);
}

const STOPPED_RESULT: ToolCallResult = { content: [{ type: 'text', text: AGENT_STOPPED_MESSAGE }], isError: true };

const CALENDAR_TOOL_NAMES: ReadonlySet<string> = new Set([...MAC_READ_TOOLS, ...MAC_CHANGE_TOOLS]);

/** The tool name for a log line. The agent chooses the name, so anything else is `unknown`. */
function loggedToolName(name: string): string {
  return CALENDAR_TOOL_NAMES.has(name) ? name : 'unknown';
}

async function answerCalendarCall(agent: string, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const result = await callMacCalendarTool(agent, name, args, {
    helper: getMacCalendarHelper(),
    account: getMacCalendarAccount,
  });
  persistDebugLog('calendars', 'calendar tool call', { agent, tool: loggedToolName(name), ok: !result.isError });
  return result;
}

/** The tools an agent sees on `/calendar`. An unreadable account lists none rather than leaving the bridge waiting. */
function calendarToolsFor(agent: string): ReturnType<typeof listMacCalendarTools> {
  try {
    const access = getMacCalendarAccount()?.access;
    return listMacCalendarTools(access && Object.hasOwn(access, agent) ? access[agent] : 'off');
  } catch (err) {
    persistDebugLog('calendars', 'calendar tool list failed', { agent, error: err instanceof Error ? err.name : 'unknown' });
    return [];
  }
}

async function launch(): Promise<HostBridgeEndpoints> {
  setHostBridgeApprovalSender(broadcast);
  const mcpToken = await ensureHostBridgeToken('mcp');
  const browserToken = await ensureHostBridgeToken('browser');
  // Reading the tokens waits on the keychain; Boundary may have started quitting meanwhile.
  if (quitting) throw new Error(`${APP_NAME} is quitting.`);
  const preferred = getHostBridgePorts();

  const proc = utilityProcess.fork(BRIDGE_ENTRY, [], { serviceName: `${APP_NAME} Host Bridge` });
  child = proc;
  credentialTokens?.stop();
  const credentials = new CredentialTokens({
    onChange: (accepted, current) => {
      if (child === proc) post(proc, { type: 'credential-tokens', tokens: accepted });
      // The end of a grace period changes only what the bridge accepts, not the file.
      if (current !== lastWritten) {
        lastWritten = current;
        persistDebugLog('host-bridge', 'credential token rotated', {});
        void syncCredentialFiles('rotated');
      }
    },
  });
  let lastWritten = credentials.current;
  credentialTokens = credentials;

  return new Promise<HostBridgeEndpoints>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host bridge did not start in time.')), START_TIMEOUT_MS);
    let readyAt: number | null = null;

    proc.on('message', (message: BridgeToMain) => {
      switch (message.type) {
        case 'ready':
          clearTimeout(timer);
          readyAt = Date.now();
          setHostBridgePorts({ mcp: message.mcpPort, browser: message.browserPort });
          persistDebugLog('host-bridge', 'ready', { mcpPort: message.mcpPort, browserPort: message.browserPort });
          if (credentialTokens === credentials) {
            credentialPort = message.browserPort;
            credentials.start();
            void syncCredentialFiles('bridge ready');
          }
          beginBridgeRun();
          resolve({ mcpPort: message.mcpPort, browserPort: message.browserPort, mcpToken, browserToken });
          return;
        case 'hermes-clients':
          if (child === proc && bridgeRun) {
            bridgeRun.clients = message.count;
            bridgeRun.peak = Math.max(bridgeRun.peak, message.count);
            // The settle fallback runs from the first client: before that Hermes may still be starting.
            if (message.count > 0 && !bridgeRun.settle && !bridgeRun.settled) scheduleSettle(HOST_TOOLS_SETTLE_MS);
            persistDebugLog('host-bridge', 'hermes clients', { count: message.count, expected: bridgeRun.expected });
            updateHermesClients();
          }
          return;
        case 'start-failed':
          clearTimeout(timer);
          reject(new Error(`Host bridge failed to start: ${message.error}`));
          return;
        case 'tool-call':
          // A call that raced Stop agent: the bridge is on its way down.
          if (isHostBridgeAgentStopped()) {
            post(proc, { type: 'tool-result', id: message.id, result: STOPPED_RESULT });
            return;
          }
          void executeHostTool(message.name, message.args, toolDeps).then((result) => {
            if (child === proc) post(proc, { type: 'tool-result', id: message.id, result });
          });
          return;
        case 'calendar-tool-call':
          if (isHostBridgeAgentStopped()) {
            post(proc, { type: 'tool-result', id: message.id, result: STOPPED_RESULT });
            return;
          }
          void answerCalendarCall(message.agent, message.name, message.args)
            .catch((err: unknown): ToolCallResult => {
              persistDebugLog('calendars', 'calendar tool call failed', { agent: message.agent, tool: loggedToolName(message.name), error: err instanceof Error ? err.name : 'unknown' });
              return { content: [{ type: 'text', text: 'The calendars on this Mac couldn’t answer.' }], isError: true };
            })
            .then((result) => {
              if (child === proc) post(proc, { type: 'tool-result', id: message.id, result });
            });
          return;
        case 'calendar-tool-list':
          post(proc, { type: 'calendar-tool-list-result', id: message.id, tools: calendarToolsFor(message.agent) });
          return;
        case 'browser-open-result':
        case 'browser-status-result': {
          const request = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          request?.resolve(message);
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
        if (credentialTokens === credentials) void endCredentialClient('bridge exited');
        setHostToolsState(idleHostToolsState());
        // Requests went to this process; fail them now rather than at their timeouts.
        for (const request of pendingRequests.values()) request.reject(new Error('The host bridge stopped.'));
        pendingRequests.clear();
      }
      denyAllHostBridgeApprovals();
      if (stopping) return;
      if (readyAt !== null && Date.now() - readyAt >= HEALTHY_RUN_MS) restarts = 0;
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
      credentialTokens: credentials.accepted,
      mcpPort: preferred.mcp,
      browserPort: preferred.browser,
      browser: browserRelayConfigFrom(getHostBridgeBrowserSettings()),
      listing: hostToolListing(),
      sessionIdleMs: HERMES_SESSION_IDLE_MS,
    });
    post(proc, { type: 'calendar-tokens', tokens: calendarTokens });
  });
}

/**
 * Replace the bridge's calendar tokens (token → agent slug). Only these open `/calendar`, and
 * each call is answered for the agent its token belongs to.
 */
export function setCalendarTokens(tokens: Record<string, string>): void {
  calendarTokens = { ...tokens };
  if (child) post(child, { type: 'calendar-tokens', tokens: calendarTokens });
}

function hostToolListing(): HostToolListing {
  return {
    offerCalendarSetup: !hasCalendarAccounts(),
    agentAppAccess: agentAppAccessEnabled(process.env, app.isPackaged),
  };
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
  if (quitting) return Promise.reject(new Error(`${APP_NAME} is quitting.`));
  // Containers on a host without callbacks can't reach a bridge on this machine.
  if (!hasStackCapability('hostCallbacks')) return Promise.reject(new StackCapabilityMissing('hostCallbacks'));
  if (isHostBridgeAgentStopped()) return Promise.reject(new Error(AGENT_STOPPED_MESSAGE));
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
  quitting = true;
  await shutDown();
}

/** End the running bridge and keep it from restarting itself. */
async function shutDown(reason?: string): Promise<void> {
  stopping = true;
  denyAllHostBridgeApprovals();
  const proc = child;
  child = null;
  ready = null;
  endBridgeRun();
  setHostToolsState(idleHostToolsState());
  const files = endCredentialClient('bridge stopped');
  if (!proc) return files;
  await files;
  await stopUtilityProcess(proc, () => post(proc, { type: 'stop', reason }), STOP_TIMEOUT_MS);
}

export interface HostBridgeAgentState {
  stopped: boolean;
  /** Set when access was turned back on but the bridge didn't start. */
  error?: string;
  /** Set when the bridge started but Hermes didn't get its tokens. */
  hermesError?: string;
}

/**
 * Puts the bridge's current tokens into Hermes. `ipcHandlers` passes the stack's apply path:
 * it writes every profile's `.env` and `browser.cdp_url`, restarts Hermes when a `.env` changed
 * (Hermes reads it only at start-up), and then wakes Hermes so it reconnects to the bridge at
 * once rather than on its 15 s parked retry.
 */
export type ProvisionHermes = () => Promise<IpcResult>;

const ROTATING_MESSAGE = `${APP_NAME} is restarting its tools with new tokens. Try again in a moment.`;

export function getHostBridgeAgentState(): HostBridgeAgentState {
  return { stopped: isHostBridgeAgentStopped() };
}

/**
 * Stop agent (ADR 0027 §7): end the bridge, which closes its MCP listener and the browser relay
 * (and Boundary's Chrome with it), deny open approvals, and answer calls still in flight with an
 * error. Hermes then finds nothing listening for its host tools and browser. The choice is
 * stored, so the bridge stays down across launches until `resumeHostBridgeAgent`.
 *
 * Both tokens are then replaced, so the stopped bridge's never work again. Hermes gets the new
 * ones in the background now, while it has nothing to reach: the `.env` change restarts it, and
 * turning access back on needs no restart.
 */
export async function stopHostBridgeAgent(provisionHermes: ProvisionHermes): Promise<HostBridgeAgentState> {
  setHostBridgeAgentStopped(true);
  persistDebugLog('host-bridge', 'agent stopped by the user', {});
  await shutDown(AGENT_STOPPED_MESSAGE);
  rotateHostBridgeTokens();
  void provisionHermes().then((result) => {
    if (!result.success) persistDebugLog('host-bridge', 'new tokens not provisioned into Hermes', { error: result.error });
  });
  return getHostBridgeAgentState();
}

/**
 * Turn computer access back on: start a bridge with the tokens Stop agent made, then run the
 * apply, which writes them into Hermes if the stop couldn't (the stack was down) and wakes it.
 */
export async function resumeHostBridgeAgent(provisionHermes: ProvisionHermes): Promise<HostBridgeAgentState> {
  setHostBridgeAgentStopped(false);
  setHostToolsState('off');
  persistDebugLog('host-bridge', 'agent access turned back on', {});
  try {
    await ensureHostBridgeStarted();
  } catch (err) {
    return { ...getHostBridgeAgentState(), error: err instanceof Error ? err.message : String(err) };
  }
  const hermes = await provisionHermes();
  return hermes.success ? getHostBridgeAgentState() : { ...getHostBridgeAgentState(), hermesError: hermes.error };
}

/**
 * Rotate tokens (ADR 0027 §3): replace both tokens, replace the running bridge so the old ones
 * stop working at once, and put the new ones into every Hermes profile. While access is stopped
 * no bridge runs, so only Hermes is updated.
 */
export async function rotateHostBridgeAgentTokens(provisionHermes: ProvisionHermes): Promise<IpcResult> {
  rotateHostBridgeTokens();
  persistDebugLog('host-bridge', 'tokens rotated by the user', {});
  if (!isHostBridgeAgentStopped()) {
    await shutDown(ROTATING_MESSAGE);
    try {
      await ensureHostBridgeStarted();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `The new tokens are saved, but ${APP_NAME}’s tools didn’t start: ${message}` };
    }
  }
  const hermes = await provisionHermes();
  return hermes.success
    ? { success: true }
    : { success: false, error: `Hermes didn’t get the new tokens: ${hermes.error ?? 'unknown error'}` };
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
    pendingRequests.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message as T);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
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
