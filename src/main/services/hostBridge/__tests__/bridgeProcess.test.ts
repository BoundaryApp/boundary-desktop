import http from 'node:http';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The real bridge entry on loopback ports, with a fake parent port standing in for main. */

const MCP_TOKEN = 'mcp-token-for-tests';
const posted: Array<Record<string, unknown>> = [];
const parentPort = Object.assign(new EventEmitter(), {
  postMessage: (m: Record<string, unknown>) => posted.push(m),
});

function send(port: number, method: string, body?: unknown, session?: string): Promise<{ status: number; session?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: '/mcp',
        headers: {
          host: `host.docker.internal:${port}`,
          authorization: `Bearer ${MCP_TOKEN}`,
          'content-type': 'application/json',
          ...(session ? { 'mcp-session-id': session } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, session: res.headers['mcp-session-id'] as string | undefined, body })
        );
      }
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
};

const clientCounts = () => posted.filter((m) => m.type === 'hermes-clients').map((m) => m.count);

describe('bridge process', () => {
  const realExit = process.exit;
  let mcpPort = 0;

  beforeAll(async () => {
    (process as unknown as { parentPort: unknown }).parentPort = parentPort;
    // Keep the bridge's own exit from ending the test worker.
    (process as unknown as { exit: unknown }).exit = () => undefined;
    await import('../bridgeProcess');
    parentPort.emit('message', {
      data: {
        type: 'start',
        mcpToken: MCP_TOKEN,
        browserToken: 'browser-token',
        mcpPort: 0,
        browserPort: 0,
        browser: { enabled: false },
        listing: { offerCalendarSetup: false },
        sessionIdleMs: 60_000,
      },
    });
    await waitFor(() => posted.some((m) => m.type === 'ready'));
    mcpPort = (posted.find((m) => m.type === 'ready') as { mcpPort: number }).mcpPort;
  });

  afterAll(async () => {
    parentPort.emit('message', { data: { type: 'stop' } });
    await waitFor(() => posted.some((m) => m.type === 'stopped'));
    await new Promise((r) => setTimeout(r, 20));
    (process as unknown as { exit: unknown }).exit = realExit;
  });

  it('counts one Hermes process that re-initializes three times as one client', async () => {
    for (let i = 0; i < 3; i++) {
      const init = await send(mcpPort, 'POST', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } },
      });
      expect(init.status).toBe(200);
      await send(mcpPort, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.session);
      await waitFor(() => clientCounts().length === 2 * i + 1);
      if (i === 2) break;
      // Hermes ends the old session before it reconnects.
      expect((await send(mcpPort, 'DELETE', undefined, init.session)).status).toBe(200);
      await waitFor(() => clientCounts().length === 2 * i + 2);
    }
    expect(clientCounts()).toEqual([1, 0, 1, 0, 1]);
  });

  it('on stop, answers a call in flight with the reason and stops listening', async () => {
    const call = send(mcpPort, 'POST', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'clipboard_read', arguments: {} },
    });
    await waitFor(() => posted.some((m) => m.type === 'tool-call'));
    parentPort.emit('message', { data: { type: 'stop', reason: 'Computer access is stopped.' } });
    const reply = await call;
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).result).toEqual({
      content: [{ type: 'text', text: 'Computer access is stopped.' }],
      isError: true,
    });
    await waitFor(() => posted.some((m) => m.type === 'stopped'));
    await expect(send(mcpPort, 'POST', { jsonrpc: '2.0', id: 4, method: 'ping' })).rejects.toThrow(/ECONNREFUSED/);
  });
});
