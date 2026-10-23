/**
 * Entry point of the host-bridge utilityProcess (ADR 0027 §1), bundled to
 * `.vite/build/hostBridge.js`. It owns the sockets and Boundary's Chrome: every tool call is sent
 * to main, which holds policy, approvals and the audit log, and answers with the result.
 */
import { startBridgeServers, type BridgeServers } from './bridgeServer';
import type { BridgeToMain, MainToBridge } from './bridgeMessages';
import { BrowserRelay } from './browserRelay';
import type { ToolCallResult } from './mcpProtocol';

const port = process.parentPort;
let servers: BridgeServers | null = null;
let relay: BrowserRelay | null = null;
let nextCallId = 1;
const clientsWithTools = new Set<string>();
const pendingCalls = new Map<number, (result: ToolCallResult) => void>();

function post(message: BridgeToMain): void {
  port.postMessage(message);
}

function log(message: string, data?: Record<string, unknown>): void {
  post({ type: 'log', message, data });
}

function callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const id = nextCallId++;
  return new Promise((resolve) => {
    pendingCalls.set(id, resolve);
    post({ type: 'tool-call', id, name, args });
  });
}

async function stop(): Promise<void> {
  for (const resolve of pendingCalls.values()) {
    resolve({ content: [{ type: 'text', text: 'Boundary is shutting down.' }], isError: true });
  }
  pendingCalls.clear();
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
      relay = new BrowserRelay(message.browser, log);
      startBridgeServers({
        mcpToken: message.mcpToken,
        browserToken: message.browserToken,
        mcpPort: message.mcpPort,
        browserPort: message.browserPort,
        callTool,
        browserRelay: relay,
        log,
        // A Hermes process registers the tools once it has listed them, so that's when they're
        // usable there. A client without a session counts once.
        onMcpMethod: (method, sessionId) => {
          const key = sessionId ?? 'no-session';
          if (method !== 'tools/list' || clientsWithTools.has(key)) return;
          clientsWithTools.add(key);
          post({ type: 'hermes-clients', count: clientsWithTools.size });
        },
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
      void stop();
      return;
  }
});
