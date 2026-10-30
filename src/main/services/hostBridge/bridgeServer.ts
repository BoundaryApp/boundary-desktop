import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { checkBridgeRequest, readLimitedBody, type GuardFailure } from './requestGuard';
import { handleMcpMessage, isReply, parseJsonRpc, type CallTool, type ListTools } from './mcpProtocol';

/**
 * The bridge's two loopback listeners (ADR 0027 §1–2). Plain Node, so tests drive it with real
 * sockets; `bridgeProcess.ts` runs it inside an Electron utilityProcess.
 *
 * - MCP listener: `POST /mcp`, host tools. Tool calls go to `callTool`, which main answers.
 * - Browser listener: WebSocket upgrades on `/devtools/browser/…` go to the browser relay
 *   (Boundary's Chrome). Its token may also come as `?token=`, because Hermes hands its CDP
 *   driver a URL rather than headers. There are no discovery endpoints (`/json/…`).
 */

const MCP_PATH = '/mcp';
export const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeServerOptions {
  mcpToken: string;
  browserToken: string;
  /** Preferred ports; 0 or a busy port falls back to a random free one. */
  mcpPort?: number;
  browserPort?: number;
  callTool: CallTool;
  /** What `tools/list` returns; the static catalog without `offer_setup` when left out. */
  listTools?: ListTools;
  /** Boundary's Chrome. Without one, browser upgrades are refused with 503. */
  browserRelay?: BrowserUpgradeTarget;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /**
   * Each authenticated JSON-RPC method, before it's handled, with the client's MCP session.
   * Sessions exist only so the bridge can tell Hermes's processes apart; nothing else uses them.
   */
  onMcpMethod?: (method: string, sessionId: string | null) => void;
  /** A client ended its MCP session (`DELETE /mcp` with the session id). */
  onSessionClosed?: (sessionId: string) => void;
}

/** What the browser listener needs from the relay (`BrowserRelay` in the bridge process). */
export interface BrowserUpgradeTarget {
  unavailableReason(): string | null;
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
}

const BROWSER_PATH_PREFIX = '/devtools/browser/';

export interface BridgeServers {
  mcpPort: number;
  browserPort: number;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body?: unknown, extra: Record<string, string> = {}) {
  if (body === undefined) {
    res.writeHead(status, extra).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
  res.end(text);
}

function rejectGuard(res: http.ServerResponse, guard: GuardFailure) {
  sendJson(res, guard.status, { error: guard.reason });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  const body = JSON.stringify({ error: reason });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body
  );
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  return (await readLimitedBody(req, MAX_BODY_BYTES))?.toString('utf8') ?? null;
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: http.Server, preferred: number | undefined): Promise<void> {
  const tryPort = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  return tryPort(preferred ?? 0).catch((err: NodeJS.ErrnoException) => {
    if (preferred && err.code === 'EADDRINUSE') return tryPort(0);
    throw err;
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startBridgeServers(options: BridgeServerOptions): Promise<BridgeServers> {
  const log = options.log ?? (() => {
    /* not logging */
  });

  const mcp = http.createServer((req, res) => {
    serveMcp(req, res).catch((err: unknown) => {
      log('mcp request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  });

  const serveMcp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const guard = checkBridgeRequest(req.headers, { port: portOf(mcp), token: options.mcpToken });
    if (guard) {
      log('mcp request rejected', { status: guard.status, reason: guard.reason });
      rejectGuard(res, guard);
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method === 'DELETE') {
      // A client ending its session (MCP Streamable HTTP), so it stops counting as connected.
      const header = req.headers['mcp-session-id'];
      if (typeof header !== 'string') {
        sendJson(res, 400, { error: 'Mcp-Session-Id is required' });
        return;
      }
      options.onSessionClosed?.(header);
      sendJson(res, 200);
      return;
    }
    if (req.method !== 'POST') {
      // No server-to-client SSE stream.
      sendJson(res, 405, { error: 'Only POST and DELETE are supported' }, { allow: 'POST, DELETE' });
      return;
    }
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendJson(res, 415, { error: 'Content-Type must be application/json' });
      return;
    }
    try {
      const raw = await readBody(req);
      if (raw === null) {
        sendJson(res, 413, { error: 'Request body too large' });
        return;
      }
      const parsed = parseJsonRpc(raw);
      if (isReply(parsed)) {
        sendJson(res, parsed.status, parsed.body);
        return;
      }
      const header = req.headers['mcp-session-id'];
      const sessionId = parsed.method === 'initialize' ? randomUUID() : typeof header === 'string' ? header : null;
      options.onMcpMethod?.(parsed.method, sessionId);
      const reply = await handleMcpMessage(parsed, options.callTool, options.listTools);
      const issue = parsed.method === 'initialize' && reply.status === 200 && sessionId;
      sendJson(res, reply.status, reply.body, issue ? { 'mcp-session-id': sessionId } : {});
    } catch (err) {
      log('mcp request failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    }
  };

  const browserGuard = (req: http.IncomingMessage) =>
    checkBridgeRequest(req.headers, { port: portOf(browser), token: options.browserToken, url: req.url });

  const browser = http.createServer((req, res) => {
    const guard = browserGuard(req);
    if (guard) {
      rejectGuard(res, guard);
      return;
    }
    sendJson(res, 404, { error: `Connect a CDP WebSocket to ${BROWSER_PATH_PREFIX}…; there are no discovery endpoints.` });
  });
  browser.on('upgrade', (req, socket, head) => {
    const guard = browserGuard(req);
    if (guard) {
      log('browser upgrade rejected', { status: guard.status, reason: guard.reason });
      rejectUpgrade(socket, guard.status, guard.reason);
      return;
    }
    if (!(req.url ?? '').startsWith(BROWSER_PATH_PREFIX)) {
      rejectUpgrade(socket, 404, `Connect to ${BROWSER_PATH_PREFIX}…`);
      return;
    }
    const relay = options.browserRelay;
    const unavailable = relay ? relay.unavailableReason() : "Boundary's browser is not set up.";
    if (!relay || unavailable) {
      rejectUpgrade(socket, 503, unavailable ?? "Boundary's browser is not set up.");
      return;
    }
    relay.handleUpgrade(req, socket, head).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      log('browser upgrade failed', { reason });
      if (!socket.destroyed) rejectUpgrade(socket, 503, reason);
    });
  });

  await listen(mcp, options.mcpPort);
  try {
    await listen(browser, options.browserPort);
  } catch (err) {
    await closeServer(mcp);
    throw err;
  }

  return {
    mcpPort: portOf(mcp),
    browserPort: portOf(browser),
    close: async () => {
      await Promise.all([closeServer(mcp), closeServer(browser)]);
    },
  };
}
