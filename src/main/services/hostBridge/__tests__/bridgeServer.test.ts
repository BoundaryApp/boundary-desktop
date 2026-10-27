import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES, startBridgeServers, type BridgeServers } from '../bridgeServer';
import type { CallTool } from '../mcpProtocol';

const MCP_TOKEN = 'mcp-token-for-tests';
const BROWSER_TOKEN = 'browser-token-for-tests';

let servers: BridgeServers | null = null;

afterEach(async () => {
  await servers?.close();
  servers = null;
});

async function start(callTool: CallTool = vi.fn(), ports: { mcpPort?: number; browserPort?: number } = {}) {
  servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool, ...ports });
  return servers;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Raw http.request so tests control Host and Origin, which fetch won't let us set. */
function request(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'POST',
        path: options.path ?? '/mcp',
        headers: {
          host: `host.docker.internal:${port}`,
          authorization: `Bearer ${MCP_TOKEN}`,
          'content-type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) });

describe('MCP listener', () => {
  it('is not reachable on the machine’s network address', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;
    if (!lan) return; // No network interface in this environment.
    const { mcpPort } = await start();
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect(mcpPort, lan);
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
  });

  it('answers initialize and lists the host tools', async () => {
    const { mcpPort } = await start();
    const init = await request(mcpPort, { body: rpc('initialize', { protocolVersion: '2025-06-18' }) });
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toContain('application/json');
    expect(init.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.parse(init.body).result.protocolVersion).toBe('2025-06-18');

    const list = await request(mcpPort, { body: rpc('tools/list') });
    expect(JSON.parse(list.body).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['desktop_notification', 'open_url', 'clipboard_write', 'clipboard_read', 'pick_files', 'read_file', 'write_file']);
  });

  it('gives each client a session and reports its methods, and nothing for rejected requests', async () => {
    const onMcpMethod = vi.fn();
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn(), onMcpMethod });
    const { mcpPort } = servers;
    await request(mcpPort, { body: rpc('tools/list'), headers: { authorization: 'Bearer wrong' } });
    expect(onMcpMethod).not.toHaveBeenCalled();

    const a = (await request(mcpPort, { body: rpc('initialize', { protocolVersion: '2025-06-18' }) })).headers['mcp-session-id'];
    const b = (await request(mcpPort, { body: rpc('initialize', { protocolVersion: '2025-06-18' }) })).headers['mcp-session-id'];
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
    await request(mcpPort, { body: rpc('tools/list'), headers: { 'mcp-session-id': String(a) } });
    await request(mcpPort, { body: rpc('tools/list') });
    const lists = onMcpMethod.mock.calls.filter(([method]) => method === 'tools/list').map(([, session]) => session);
    expect(lists).toEqual([a, null]);
    // Only initialize hands out a session.
    expect((await request(mcpPort, { body: rpc('ping') })).headers['mcp-session-id']).toBeUndefined();
  });

  it('reports a client ending its session, and nothing for a rejected one', async () => {
    const onSessionClosed = vi.fn();
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn(), onSessionClosed });
    const { mcpPort } = servers;
    const rejected = await request(mcpPort, { method: 'DELETE', headers: { authorization: 'Bearer wrong', 'mcp-session-id': 'a' } });
    expect(rejected.status).toBe(401);
    expect(onSessionClosed).not.toHaveBeenCalled();
    expect((await request(mcpPort, { method: 'DELETE', headers: { 'mcp-session-id': 'a' } })).status).toBe(200);
    expect(onSessionClosed).toHaveBeenCalledWith('a');
  });

  it('answers 500 when a step outside the body handling throws', async () => {
    const onSessionClosed = vi.fn(() => {
      throw new Error('listener failed');
    });
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn(), onSessionClosed });
    const res = await request(servers.mcpPort, { method: 'DELETE', headers: { 'mcp-session-id': 'a' } });
    expect(res.status).toBe(500);
  });

  it('acknowledges notifications with 202 and no body', async () => {
    const { mcpPort } = await start();
    const reply = await request(mcpPort, { body: rpc('notifications/initialized', undefined, null) });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('');
  });

  it('routes tools/call to main and returns its result', async () => {
    const callTool = vi.fn<CallTool>().mockResolvedValue({ content: [{ type: 'text', text: 'Notification shown.' }] });
    const { mcpPort } = await start(callTool);
    const reply = await request(mcpPort, { body: rpc('tools/call', { name: 'desktop_notification', arguments: { title: 'Done' } }) });
    expect(callTool).toHaveBeenCalledWith('desktop_notification', { title: 'Done' });
    expect(JSON.parse(reply.body).result.content[0].text).toBe('Notification shown.');
  });

  it('checks the token, Origin and Host before anything else', async () => {
    const callTool = vi.fn<CallTool>();
    const { mcpPort } = await start(callTool);
    const body = rpc('tools/call', { name: 'desktop_notification', arguments: { title: 'x' } });
    expect((await request(mcpPort, { body, headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await request(mcpPort, { body, headers: { authorization: `Bearer ${BROWSER_TOKEN}` } })).status).toBe(401);
    expect((await request(mcpPort, { body, headers: { origin: `http://localhost:${mcpPort}` } })).status).toBe(403);
    expect((await request(mcpPort, { body, headers: { host: `attacker.example:${mcpPort}` } })).status).toBe(421);
    // Even a wrong path or method learns nothing without the token.
    expect((await request(mcpPort, { method: 'GET', path: '/', headers: { authorization: '' } })).status).toBe(401);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects other methods, paths and content types once authenticated', async () => {
    const { mcpPort } = await start();
    const get = await request(mcpPort, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST, DELETE');
    expect((await request(mcpPort, { method: 'HEAD' })).status).toBe(405);
    expect((await request(mcpPort, { method: 'DELETE' })).status).toBe(400);
    expect((await request(mcpPort, { path: '/other', body: rpc('ping') })).status).toBe(404);
    expect((await request(mcpPort, { body: rpc('ping'), headers: { 'content-type': 'text/plain' } })).status).toBe(415);
  });

  it('refuses oversized bodies, bad JSON and batches', async () => {
    const { mcpPort } = await start();
    const big = await request(mcpPort, { body: Buffer.alloc(MAX_BODY_BYTES + 10, 'a') }).catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);
    expect((await request(mcpPort, { body: '{not json' })).status).toBe(400);
    expect((await request(mcpPort, { body: `[${rpc('ping')}]` })).status).toBe(400);
  });

  it('falls back to a free port when the preferred one is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      const { mcpPort } = await start(vi.fn(), { mcpPort: taken });
      expect(mcpPort).not.toBe(taken);
      expect((await request(mcpPort, { body: rpc('ping') })).status).toBe(200);
    } finally {
      blocker.close();
    }
  });
});

describe('browser listener', () => {
  function upgrade(
    browserPort: number,
    { path = '/devtools/browser/boundary', authorization, origin }: { path?: string; authorization?: string; origin?: string } = {}
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: browserPort,
        path,
        headers: {
          host: `host.docker.internal:${browserPort}`,
          ...(authorization ? { authorization } : {}),
          ...(origin ? { origin } : {}),
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.on('error', reject);
      req.end();
    });
  }

  function fakeRelay(unavailable: string | null = null) {
    return {
      unavailableReason: vi.fn(() => unavailable),
      handleUpgrade: vi.fn(async (_req: http.IncomingMessage, socket: import('node:stream').Duplex) => {
        socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      }),
    };
  }

  it('checks its own token and serves no discovery endpoints', async () => {
    const { browserPort } = await start();
    expect((await request(browserPort, { method: 'GET', path: '/json/version' })).status).toBe(401);
    const authed = await request(browserPort, {
      method: 'GET',
      path: '/json/version',
      headers: { authorization: `Bearer ${BROWSER_TOKEN}` },
    });
    expect(authed.status).toBe(404);
  });

  it('hands an authenticated upgrade to the relay, with the token in the header or the query', async () => {
    const relay = fakeRelay();
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn(), browserRelay: relay });
    const port = servers.browserPort;
    expect(await upgrade(port, { authorization: `Bearer ${BROWSER_TOKEN}` })).toBe(101);
    expect(await upgrade(port, { path: `/devtools/browser/boundary?token=${BROWSER_TOKEN}` })).toBe(101);
    expect(relay.handleUpgrade).toHaveBeenCalledTimes(2);
  });

  it('refuses the MCP token, a wrong query token, web pages and other paths before the relay sees them', async () => {
    const relay = fakeRelay();
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn(), browserRelay: relay });
    const port = servers.browserPort;
    expect(await upgrade(port, { authorization: `Bearer ${MCP_TOKEN}` })).toBe(401);
    expect(await upgrade(port, { path: '/devtools/browser/boundary?token=nope' })).toBe(401);
    expect(await upgrade(port, { path: `/devtools/browser/boundary?token=${BROWSER_TOKEN}`, origin: 'https://evil.example' })).toBe(403);
    expect(await upgrade(port, { path: `/devtools/page/x?token=${BROWSER_TOKEN}` })).toBe(404);
    expect(relay.handleUpgrade).not.toHaveBeenCalled();
  });

  it('answers 503 when the browser is off or there is no relay', async () => {
    const relay = fakeRelay("Boundary's browser is turned off.");
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn(), browserRelay: relay });
    expect(await upgrade(servers.browserPort, { authorization: `Bearer ${BROWSER_TOKEN}` })).toBe(503);
    await servers.close();
    servers = await startBridgeServers({ mcpToken: MCP_TOKEN, browserToken: BROWSER_TOKEN, callTool: vi.fn() });
    expect(await upgrade(servers.browserPort, { authorization: `Bearer ${BROWSER_TOKEN}` })).toBe(503);
  });
});
