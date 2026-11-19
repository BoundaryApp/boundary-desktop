import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_MAX_BODY_BYTES,
  SERVICE_MEMBER_CONCURRENCY,
  ServiceGateway,
  type ServiceGatewayDeps,
  type ServiceRequest,
} from '../serviceGateway';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const CIRCLE = 'c'.repeat(64);
const DEVICE = 'd'.repeat(64);
const MEMBER = 'a'.repeat(64);
const SERVICE = 'twenty-main';
const READ_KEY = 'read-key-secret';
const WRITE_KEY = 'write-key-secret';
const MCP_URL = 'http://127.0.0.1:3000/mcp';

function sink() {
  let finish: () => void = () => undefined;
  const result = {
    status: 0,
    contentType: '',
    chunks: [] as Buffer[],
    error: undefined as string | undefined,
    done: new Promise<void>((resolve) => (finish = resolve)),
    head: (status: number, contentType: string) => {
      result.status = status;
      result.contentType = contentType;
    },
    chunk: (data: Buffer): void => void result.chunks.push(Buffer.from(data)),
    end: (error?: string) => {
      result.error = error;
      finish();
    },
    text: () => Buffer.concat(result.chunks).toString('utf8'),
  };
  return result;
}

function heldFetch() {
  const calls: Array<{ url: string; init: RequestInit; release: (response: Response) => void }> = [];
  const fetchImpl = vi.fn(
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, init, release: resolve });
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
  );
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const toolCall = (name = 'find_many_people') =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { filter: 'Ada Lovelace' } } });

const request = (overrides: Partial<ServiceRequest> = {}): ServiceRequest => ({
  id: 1,
  circle: CIRCLE,
  service: SERVICE,
  level: 'read',
  method: 'POST',
  path: '/mcp',
  accept: 'application/json, text/event-stream',
  body: toolCall(),
  ...overrides,
});

function gateway(overrides: Partial<ServiceGatewayDeps> = {}) {
  const held = heldFetch();
  const log = vi.fn();
  const diag = vi.fn();
  const onUsage = vi.fn();
  const deps: ServiceGatewayDeps = {
    offerFor: () => ({ available: true }),
    memberFor: (circle, device) => (circle === CIRCLE && device === DEVICE ? MEMBER : null),
    grantFor: () => ({ read: READ_KEY, write: WRITE_KEY }),
    upstream: () => ({ mcpUrl: MCP_URL }),
    fetchImpl: held.fetchImpl,
    log,
    diag,
    onUsage,
    ...overrides,
  };
  return { gw: new ServiceGateway(deps), ...held, log, diag, onUsage };
}

describe('ServiceGateway', () => {
  afterEach(() => vi.useRealTimers());

  it('forwards a read call with the member’s read key and the client’s Accept', async () => {
    const { gw, calls } = gateway();
    const out = sink();
    gw.handle(DEVICE, request(), out);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(MCP_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${READ_KEY}`,
    });
    expect(calls[0]!.init.redirect).toBe('error');
    calls[0]!.release(new Response('event: message\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    await out.done;
    expect(out.status).toBe(200);
    expect(out.contentType).toBe('text/event-stream');
    expect(out.text()).toBe('event: message\ndata: {}\n\n');
    expect(out.error).toBeUndefined();
  });

  it('uses the write key for a write call', () => {
    const { gw, calls } = gateway();
    gw.handle(DEVICE, request({ level: 'write' }), sink());
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${WRITE_KEY}`);
  });

  it('refuses a write call from a member granted read only', async () => {
    const { gw, calls } = gateway({ grantFor: () => ({ read: READ_KEY }) });
    const out = sink();
    gw.handle(DEVICE, request({ level: 'write' }), out);
    await out.done;
    expect(out.status).toBe(403);
    expect(out.text()).toContain('look things up here but not make changes');
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a GET', { method: 'GET' }, 404],
    ['another path', { path: '/rest/people' }, 404],
    ['GraphQL', { path: '/graphql' }, 404],
  ])('refuses %s', async (_name, overrides, status) => {
    const { gw, calls } = gateway();
    const out = sink();
    gw.handle(DEVICE, request(overrides as Partial<ServiceRequest>), out);
    await out.done;
    expect(out.status).toBe(status);
    expect(calls).toHaveLength(0);
  });

  it('accepts a trailing slash on /mcp', () => {
    const { gw, calls } = gateway();
    gw.handle(DEVICE, request({ path: '/mcp/' }), sink());
    expect(calls).toHaveLength(1);
  });

  it('passes on mode=meta, which Hermes registers, and drops any other query', () => {
    const { gw, calls } = gateway();
    gw.handle(DEVICE, request({ path: '/mcp?mode=meta' }), sink());
    gw.handle(DEVICE, request({ path: '/mcp?mode=meta&token=x' }), sink());
    gw.handle(DEVICE, request({ path: '/mcp?mode=other' }), sink());
    expect(calls.map((call) => call.url)).toEqual([`${MCP_URL}?mode=meta`, `${MCP_URL}?mode=meta`, MCP_URL]);
  });

  it('refuses a device that isn’t a member', async () => {
    const { gw, calls } = gateway();
    const out = sink();
    gw.handle('e'.repeat(64), request(), out);
    await out.done;
    expect(out.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a member with no grant', async () => {
    const { gw } = gateway({ grantFor: () => null });
    const out = sink();
    gw.handle(DEVICE, request(), out);
    await out.done;
    expect(out.status).toBe(403);
    expect(out.text()).toContain('haven’t been given access');
  });

  it('refuses while the offer is paused or gone, and when the instance isn’t running', async () => {
    for (const overrides of [
      { offerFor: () => ({ available: false }) },
      { offerFor: () => null },
      { upstream: () => null },
    ] as Partial<ServiceGatewayDeps>[]) {
      const { gw, calls } = gateway(overrides);
      const out = sink();
      gw.handle(DEVICE, request(), out);
      await out.done;
      expect(out.status).toBe(503);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a body over the limit and a body that isn’t a JSON object', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(SERVICE_MAX_BODY_BYTES) });
    for (const [body, status] of [
      [big, 413],
      ['not json', 400],
      ['"a string"', 400],
    ] as const) {
      const { gw, calls } = gateway();
      const out = sink();
      gw.handle(DEVICE, request({ body }), out);
      await out.done;
      expect(out.status).toBe(status);
      expect(calls).toHaveLength(0);
    }
  });

  it('lets a member run four calls at once and refuses the fifth', async () => {
    const { gw, calls } = gateway();
    for (let id = 1; id <= SERVICE_MEMBER_CONCURRENCY; id++) gw.handle(DEVICE, request({ id }), sink());
    const fifth = sink();
    gw.handle(DEVICE, request({ id: 99 }), fifth);
    await fifth.done;
    expect(fifth.status).toBe(429);
    expect(calls).toHaveLength(SERVICE_MEMBER_CONCURRENCY);

    calls[0]!.release(new Response('{}', { status: 200 }));
    await flush();
    await flush();
    gw.handle(DEVICE, request({ id: 100 }), sink());
    expect(calls).toHaveLength(SERVICE_MEMBER_CONCURRENCY + 1);
  });

  it('counts each forwarded call for the member', () => {
    // Only Date is faked, at local noon, so the day can't change during the test.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 3, 1, 12));
    const { gw, onUsage } = gateway({ usage: { day: '2026-04-01', counts: { [MEMBER]: { requests: 2, tokens: 0 } } } });
    gw.handle(DEVICE, request(), sink());
    expect(onUsage).toHaveBeenLastCalledWith({
      day: '2026-04-01',
      counts: { [MEMBER]: { requests: 3, tokens: 0 } },
    });
  });

  it('passes Twenty’s own error status through', async () => {
    const { gw, calls } = gateway();
    const out = sink();
    gw.handle(DEVICE, request(), out);
    calls[0]!.release(new Response('{"error":"Unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }));
    await out.done;
    expect(out.status).toBe(401);
  });

  it('answers 502 when the instance can’t be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const { gw, log } = gateway({ fetchImpl });
    const out = sink();
    gw.handle(DEVICE, request(), out);
    await out.done;
    expect(out.status).toBe(502);
    expect(log).toHaveBeenCalledWith('shared service request failed', expect.objectContaining({ error: 'TypeError', cancelled: false }));
  });

  it('stops a call when its device disconnects', async () => {
    const { gw, calls } = gateway();
    const out = sink();
    gw.handle(DEVICE, request(), out);
    expect(gw.stats().running).toBe(1);
    gw.dropPeer(DEVICE);
    await out.done;
    expect(out.status).toBe(503);
    await flush();
    expect(gw.stats().running).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('cancels one call by id and leaves the others', async () => {
    const { gw, calls } = gateway();
    const first = sink();
    gw.handle(DEVICE, request({ id: 1 }), first);
    gw.handle(DEVICE, request({ id: 2 }), sink());
    gw.cancel(DEVICE, 1);
    await first.done;
    await flush();
    expect(gw.stats().running).toBe(1);
    expect(calls[1]!.init.signal?.aborted).toBe(false);
  });

  it('ends a reply cut off mid-stream with an error', async () => {
    const { gw, calls } = gateway();
    const out = sink();
    gw.handle(DEVICE, request(), out);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\n'));
        controller.error(new Error('reset'));
      },
    });
    calls[0]!.release(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    await out.done;
    expect(out.status).toBe(200);
    expect(out.error).toBe('The service stopped mid-reply.');
  });

  it('refuses everything after close and stops what is running', async () => {
    const { gw } = gateway();
    const running = sink();
    gw.handle(DEVICE, request(), running);
    gw.close();
    await running.done;
    const after = sink();
    gw.handle(DEVICE, request({ id: 2 }), after);
    await after.done;
    expect(after.status).toBe(503);
  });

  it('logs the method and tool name, never arguments or keys', async () => {
    const { gw, calls, log, diag } = gateway();
    const out = sink();
    gw.handle(DEVICE, request({ level: 'write', body: toolCall('execute_tool') }), out);
    calls[0]!.release(new Response('{}', { status: 200 }));
    await out.done;
    await flush();
    expect(log).toHaveBeenCalledWith(
      'shared service request',
      expect.objectContaining({ rpc: 'tools/call', tool: 'execute_tool', level: 'write', status: 200 })
    );
    const logged = JSON.stringify([log.mock.calls, diag.mock.calls]);
    expect(logged).not.toContain('Ada Lovelace');
    expect(logged).not.toContain(READ_KEY);
    expect(logged).not.toContain(WRITE_KEY);
  });
});
