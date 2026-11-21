import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import type { ServiceCall } from '../networkMessages';
import { checkAgentRequest, readLimitedBody } from '../../hostBridge/requestGuard';
import { startServiceListener, type ServiceListener } from '../serviceListener';
import type { AgentRequestGuard } from '../sharingConfig';

const READ = 'read-token-for-the-listener-test';
const WRITE = 'write-token-for-the-listener-test';
const guard: AgentRequestGuard = { check: checkAgentRequest, readBody: readLimitedBody };
const INIT = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });

let listener: ServiceListener | null = null;

afterEach(async () => {
  await listener?.close();
  listener = null;
});

async function start(call: (request: ServiceCall, signal: AbortSignal) => Promise<Response>, withGuard = guard) {
  const spy = vi.fn(call);
  listener = await startServiceListener({
    guard: withGuard,
    port: 0,
    tokens: { read: READ, write: WRITE },
    service: 'twenty.main',
    describe: () => ({ provider: 'Ada', service: 'Twenty' }),
    call: spy,
  });
  return { spy, url: `http://127.0.0.1:${listener.port}` };
}

const post = (url: string, init: { token?: string; body?: string; path?: string; headers?: Record<string, string> } = {}) =>
  fetch(`${url}${init.path ?? '/mcp'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(init.token === undefined ? { Authorization: `Bearer ${READ}` } : init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.body ?? INIT,
  });

const ok = () => Promise.resolve(new Response('{"jsonrpc":"2.0","id":7,"result":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));

describe('startServiceListener', () => {
  it('sends a read-token call at the read level with the path, Accept and body', async () => {
    const { spy, url } = await start(ok);
    const response = await post(url, { path: '/mcp?mode=meta' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(spy.mock.calls[0]![0]).toEqual({
      service: 'twenty.main',
      level: 'read',
      method: 'POST',
      path: '/mcp?mode=meta',
      accept: 'application/json, text/event-stream',
      body: INIT,
    });
  });

  it('sends a write-token call at the write level', async () => {
    const { spy, url } = await start(ok);
    await post(url, { token: WRITE });
    expect(spy.mock.calls[0]![0].level).toBe('write');
  });

  it('streams an event-stream reply through', async () => {
    const { url } = await start(() =>
      Promise.resolve(new Response('event: message\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    );
    const response = await post(url);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('event: message\ndata: {}\n\n');
  });

  it.each([
    ['no token', { token: '' }, 401],
    ['a wrong token', { token: 'nope' }, 401],
    ['a web page', { headers: { Origin: 'https://example.com' } }, 403],
    ['another path', { path: '/graphql' }, 404],
  ])('refuses %s without calling the provider', async (_name, init, status) => {
    const { spy, url } = await start(ok);
    const response = await post(url, init);
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect((await response.json()).error.message).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers a GET with 405, which the MCP client takes as no event stream', async () => {
    const { spy, url } = await start(ok);
    const response = await fetch(`${url}/mcp`, { headers: { Authorization: `Bearer ${READ}` } });
    expect(response.status).toBe(405);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a body over 1 MB and one that isn’t JSON', async () => {
    const { spy, url } = await start(ok);
    expect((await post(url, { body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
    expect((await post(url, { body: 'not json' })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  // The client is still uploading when the 413 is ready. Closing before the body is read makes
  // the client's next write fail with ECONNRESET instead of reading the answer.
  it('reads an oversized body before answering 413, so the client gets the answer, not a reset', async () => {
    const { spy } = await start(ok);
    const size = 1024 * 1024 + 1;
    const socket = net.connect(listener!.port, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    const closed = new Promise<Error | null>((resolve) => {
      socket.on('error', (error) => resolve(error));
      socket.on('close', () => resolve(null));
    });
    const write = (data: string | Buffer) =>
      new Promise<void>((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve())));
    await write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${listener!.port}\r\nAuthorization: Bearer ${READ}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${size}\r\n\r\n`
    );
    const chunk = Buffer.alloc(16 * 1024, 'x');
    let sent = 0;
    let writeError: unknown = null;
    try {
      while (sent < size) {
        const part = chunk.subarray(0, Math.min(chunk.length, size - sent));
        await write(part);
        sent += part.length;
        // Let the server's reply and close land between writes, as they do on a slow runner.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      writeError = error;
    }
    socket.end();
    expect(await closed).toBeNull();
    expect(writeError).toBeNull();
    expect(Buffer.concat(received).toString('latin1')).toMatch(/^HTTP\/1\.1 413 /);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cuts off a declared length too large to read and drop, without calling the provider', async () => {
    const { spy } = await start(ok);
    const socket = net.connect(listener!.port, '127.0.0.1');
    const closed = new Promise<void>((resolve) => {
      socket.on('error', () => undefined);
      socket.on('close', () => resolve());
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${listener!.port}\r\nAuthorization: Bearer ${READ}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${100 * 1024 * 1024}\r\n\r\n`
    );
    await closed;
    expect(spy).not.toHaveBeenCalled();
  });

  it('says the provider is offline, naming them, as a JSON-RPC error for the request', async () => {
    const { url } = await start(() => Promise.reject(new Error('The provider is not connected.')));
    const response = await post(url);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.id).toBe(7);
    expect(body.error.message).toMatch(/^Ada’s Mac is offline/);
    expect(body.error.message).toContain('Twenty');
  });

  it('passes the gateway’s refusal on with the provider’s name', async () => {
    const { url } = await start(() =>
      Promise.resolve(Response.json({ error: { message: 'You can look things up here but not make changes.' } }, { status: 403 }))
    );
    const response = await post(url, { token: WRITE });
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toBe('Ada’s Twenty: You can look things up here but not make changes.');
  });

  it('cancels the call when the client hangs up', async () => {
    let called!: (signal: AbortSignal) => void;
    const reached = new Promise<AbortSignal>((resolve) => (called = resolve));
    const { url } = await start((_request, signal) => {
      called(signal);
      return new Promise<Response>(() => undefined);
    });
    const pending = post(url).catch((): null => null);
    const signal = await reached;
    await listener!.close();
    listener = null;
    await pending;
    expect(signal.aborted).toBe(true);
  });

  it("refuses with the guard's status and reason", async () => {
    const { spy, url } = await start(ok, { ...guard, check: () => ({ status: 403, reason: 'nope' }) });
    const response = await post(url);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: 'nope' } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects with EADDRINUSE when the kept port is taken', async () => {
    await start(ok);
    await expect(
      startServiceListener({
        guard,
        port: listener!.port,
        tokens: { read: READ, write: WRITE },
        service: 'twenty.main',
        describe: () => ({ provider: 'Ada', service: 'Twenty' }),
        call: ok,
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
