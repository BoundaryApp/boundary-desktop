/**
 * Entry point of the host-bridge utilityProcess (ADR 0027 §1), bundled to
 * `.vite/build/hostBridge.js`. It owns the sockets and Boundary's Chrome: every tool call is sent
 * to main, which holds policy, approvals and the audit log, and answers with the result.
 */
import { startBridgeServers, type BridgeServers } from './bridgeServer';
import type { BridgeToMain, HostToolListing, MainToBridge } from './bridgeMessages';
import { BrowserRelay } from './browserRelay';
import { LiveHermesSessions } from './hermesSessions';
import type { ToolCallResult } from './mcpProtocol';
import { listedHostTools } from './toolCatalog';
import { APP_NAME } from '../../../shared/buildIdentity';

const port = process.parentPort;
let servers: BridgeServers | null = null;
let relay: BrowserRelay | null = null;
let nextCallId = 1;
let listing: HostToolListing = { offerCalendarSetup: false };
let hermesSessions: LiveHermesSessions | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
const pendingCalls = new Map<number, (result: ToolCallResult) => void>();

function post(message: BridgeToMain): void {
  port.postMessage(message);
}

function log(message: string, data?: Record<string, unknown>): void {
  post({ type: 'log', message, data });
}

/**
 * Above main's 120 s approval timeout, so an unanswered approval reaches Hermes as main's own
 * answer, and under Hermes's 180 s call timeout, so a lost reply still gets one.
 */
const TOOL_CALL_TIMEOUT_MS = 150_000;

function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const id = nextCallId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      resolve({ content: [{ type: 'text', text: `${APP_NAME} did not answer this call in time.` }], isError: true });
    }, TOOL_CALL_TIMEOUT_MS);
    pendingCalls.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    post({ type: 'tool-call', id, name, args });
  });
}

function postHermesClients(changed: boolean | undefined): void {
  if (changed && hermesSessions) post({ type: 'hermes-clients', count: hermesSessions.count });
}

async function stop(reason = `${APP_NAME} is shutting down.`): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  for (const resolve of pendingCalls.values()) {
    resolve({ content: [{ type: 'text', text: reason }], isError: true });
  }
  pendingCalls.clear();
  // Let those answers reach Hermes before the connections close.
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([servers?.close(), relay?.close()]);
  servers = null;
  relay = null;
  post({ type: 'stopped' });
  // The parent port keeps the process alive; leave on our own once the sockets are closed.
  setImmediate(() => process.exit(0));
}

port.on('message', (event: { data: MainToBridge }) => {
  const message = event.data;
  switch (message.type) {
    case 'start':
      if (servers) return;
      listing = message.listing;
      relay = new BrowserRelay(message.browser, log);
      hermesSessions = new LiveHermesSessions(message.sessionIdleMs);
      sweepTimer = setInterval(() => postHermesClients(hermesSessions?.sweep()), message.sessionIdleMs / 2);
      sweepTimer.unref();
      startBridgeServers({
        mcpToken: message.mcpToken,
        browserToken: message.browserToken,
        mcpPort: message.mcpPort,
        browserPort: message.browserPort,
        callTool,
        listTools: () => listedHostTools(listing),
        browserRelay: relay,
        log,
        // A Hermes process registers the tools once it has listed them, so that's when they're
        // usable there. Its keepalive pings keep the session counted.
        onMcpMethod: (method, sessionId) => postHermesClients(hermesSessions?.seen(method, sessionId)),
        onSessionClosed: (sessionId) => postHermesClients(hermesSessions?.closed(sessionId)),
      })
        .then((started) => {
          servers = started;
          post({ type: 'ready', mcpPort: started.mcpPort, browserPort: started.browserPort });
        })
        .catch((err: unknown) => {
          post({ type: 'start-failed', error: err instanceof Error ? err.message : String(err) });
        });
      return;
    case 'tool-result': {
      const resolve = pendingCalls.get(message.id);
      pendingCalls.delete(message.id);
      resolve?.(message.result);
      return;
    }
    case 'browser-config':
      relay?.configure(message.browser);
      return;
    case 'tool-listing':
      listing = message.listing;
      return;
    case 'browser-open': {
      const { id } = message;
      (relay ? relay.open() : Promise.reject(new Error('The bridge is not running.')))
        .then(() => post({ type: 'browser-open-result', id }))
        .catch((err: unknown) =>
          post({ type: 'browser-open-result', id, error: err instanceof Error ? err.message : String(err) })
        );
      return;
    }
    case 'browser-status': {
      const status = relay?.status() ?? { running: false, clients: 0 };
      post({ type: 'browser-status-result', id: message.id, ...status });
      return;
    }
    case 'stop':
      void stop(message.reason);
      return;
  }
});
