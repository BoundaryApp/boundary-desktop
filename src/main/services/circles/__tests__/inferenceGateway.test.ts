import { describe, expect, it, vi } from 'vitest';
import { localDay } from '../../../../shared/circleUsage';
import type { CircleOffer } from '../circleOps';
import {
  GATEWAY_CHUNK_BYTES,
  GATEWAY_MAX_BODY_BYTES,
  InferenceGateway,
  type GatewayRequest,
  type InferenceGatewayDeps,
} from '../inferenceGateway';

/** Lets pending promise callbacks run; the gateway starts the next job from one. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const CIRCLE = 'c'.repeat(64);
const DEVICE = 'd'.repeat(64);
const MEMBER = 'a'.repeat(64);

const offer: CircleOffer = {
  models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }],
  available: true,
  away: false,
};

/** Collects what a sink receives, and resolves `done` on `end`. */
function sink() {
  let finish: () => void = () => undefined;
  const result = {
    status: 0,
    contentType: '',
    chunks: [] as Buffer[],
    error: undefined as string | undefined,
    ended: false,
    done: new Promise<void>((resolve) => (finish = resolve)),
    head: (status: number, contentType: string) => {
      result.status = status;
      result.contentType = contentType;
    },
    chunk: (data: Buffer) => void result.chunks.push(Buffer.from(data)),
    end: (error?: string) => {
      result.error = error;
      result.ended = true;
      finish();
    },
    text: () => Buffer.concat(result.chunks).toString('utf8'),
  };
  return result;
}

/** A fetch whose replies the test releases one at a time. */
function heldFetch() {
  const calls: Array<{ url: string; init: RequestInit; release: (response: Response) => void; fail: (err: Error) => void }> = [];
  const fetchImpl = vi.fn(
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, init, release: resolve, fail: reject });
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
  );
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function gateway(overrides: Partial<InferenceGatewayDeps> = {}) {
  const log = vi.fn();
  const deps: InferenceGatewayDeps = {
    offerFor: (circle) => (circle === CIRCLE ? offer : null),
    memberFor: (circle, device) => (circle === CIRCLE && device === DEVICE ? MEMBER : null),
    upstream: () => ({ baseUrl: 'http://127.0.0.1:1234/v1/', apiKey: 'lm-key' }),
    log,
    ...overrides,
  };
  return { gw: new InferenceGateway(deps), log };
}

const chat = (id: number, model = 'qwen3-8b', extra: Partial<GatewayRequest> = {}): GatewayRequest => ({
  id,
  circle: CIRCLE,
  method: 'POST',
  path: '/v1/chat/completions',
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'secret prompt' }] }),
  ...extra,
});

/** A streamed reply made of `parts`. */
function streamed(parts: string[], status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
    { status, headers: { 'content-type': 'text/event-stream' } }
  );
}

describe('InferenceGateway', () => {
  it('refuses anything outside the narrow API, members and offer', async () => {
    const { calls, fetchImpl } = heldFetch();
    const cases: Array<[Partial<InferenceGatewayDeps>, string, GatewayRequest, number]> = [
      [{}, DEVICE, { ...chat(1), path: '/api/pull' }, 404],
      [{}, DEVICE, { ...chat(1), method: 'DELETE', path: '/v1/models' }, 404],
      [{}, DEVICE, { ...chat(1), method: 'GET' }, 404],
      [{}, 'e'.repeat(64), chat(1), 403],
      [{}, DEVICE, { ...chat(1), circle: 'f'.repeat(64) }, 403],
      [{ offerFor: () => null }, DEVICE, chat(1), 503],
      [{ offerFor: () => ({ ...offer, available: false }) }, DEVICE, chat(1), 503],
      [{ upstream: () => null }, DEVICE, chat(1), 503],
      [{}, DEVICE, { ...chat(1), body: '{nope' }, 400],
      [{}, DEVICE, { ...chat(1), body: 'null' }, 400],
      [{}, DEVICE, chat(1, 'llama-70b'), 404],
      [{}, DEVICE, { ...chat(1), body: 'x'.repeat(GATEWAY_MAX_BODY_BYTES + 1) }, 413],
    ];
    for (const [deps, device, request, status] of cases) {
      const { gw } = gateway({ fetchImpl, ...deps });
      const out = sink();
      gw.handle(device, request, out);
      await out.done;
      expect({ path: request.path, status: out.status }).toEqual({ path: request.path, status });
      expect(JSON.parse(out.text()).error.type).toBe('boundary_gateway_error');
    }
    expect(calls).toHaveLength(0);
  });

  it('lists only offered models that the server has, with their context', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ data: [{ id: 'qwen3-8b' }, { id: 'private-finetune' }] })
    ) as unknown as typeof fetch;
    const { gw } = gateway({ fetchImpl });
    const out = sink();
    gw.handle(DEVICE, { id: 1, circle: CIRCLE, method: 'GET', path: '/v1/models/' }, out);
    await out.done;
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/models', expect.anything());
    expect(out.status).toBe(200);
    expect(JSON.parse(out.text())).toEqual({
      object: 'list',
      data: [{ id: 'qwen3-8b', object: 'model', owned_by: 'circle', context_length: 32768 }],
    });
  });

  it('forwards a chat request with the server’s key and streams the reply back', async () => {
    const { calls, fetchImpl } = heldFetch();
    const { gw, log } = gateway({ fetchImpl });
    const out = sink();
    gw.handle(DEVICE, chat(7), out);
    expect(calls[0].url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer lm-key' });
    expect(calls[0].init.body).toBe(chat(7).body);
    calls[0].release(streamed(['data: {"a":1}\n\n', 'data: [DONE]\n\n']));
    await out.done;
    expect(out.status).toBe(200);
    expect(out.contentType).toBe('text/event-stream');
    expect(out.text()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(out.error).toBeUndefined();
    // Metadata only (ADR 0034 §6).
    expect(log).toHaveBeenCalledWith('shared model request', expect.objectContaining({ model: 'qwen3-8b', status: 200 }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret prompt');
  });

  it('passes the server’s own refusal through', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":"busy"}', { status: 429 })) as unknown as typeof fetch;
    const { gw } = gateway({ fetchImpl });
    const out = sink();
    gw.handle(DEVICE, chat(1), out);
    await out.done;
    expect(out.status).toBe(429);
    expect(out.text()).toBe('{"error":"busy"}');
  });

  it('splits large reply pieces', async () => {
    const fetchImpl = vi.fn(async () => streamed(['x'.repeat(GATEWAY_CHUNK_BYTES * 2 + 5)])) as unknown as typeof fetch;
    const { gw } = gateway({ fetchImpl });
    const out = sink();
    gw.handle(DEVICE, chat(1), out);
    await out.done;
    expect(out.chunks.map((chunk) => chunk.length)).toEqual([GATEWAY_CHUNK_BYTES, GATEWAY_CHUNK_BYTES, 5]);
  });

  it('runs chat requests one at a time, in order', async () => {
    const { calls, fetchImpl } = heldFetch();
    const { gw } = gateway({ fetchImpl });
    const first = sink();
    const second = sink();
    gw.handle(DEVICE, chat(1), first);
    gw.handle(DEVICE, chat(2), second);
    expect(calls).toHaveLength(1);
    calls[0].release(streamed(['one']));
    await first.done;
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].release(streamed(['two']));
    await second.done;
    expect([first.text(), second.text()]).toEqual(['one', 'two']);
  });

  it('drops a cancelled queued request, stops a cancelled running one, and moves on', async () => {
    const { calls, fetchImpl } = heldFetch();
    const { gw } = gateway({ fetchImpl });
    const [a, b, c] = [sink(), sink(), sink()];
    gw.handle(DEVICE, chat(1), a);
    gw.handle(DEVICE, chat(2), b);
    gw.handle(DEVICE, chat(3), c);
    gw.cancel(DEVICE, 2);
    gw.cancel(DEVICE, 1);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].init.body).toBe(chat(3).body);
    // A cancelled request needs no answer: the consumer has already stopped listening.
    expect(a.ended).toBe(false);
    expect(b.ended).toBe(false);
    calls[1].release(streamed(['three']));
    await c.done;
    expect(c.text()).toBe('three');
  });

  it('ends a reply that breaks mid-stream with an error, and answers 502 when unreachable', async () => {
    let pulls = 0;
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('data: partial'));
          else controller.error(new Error('socket hang up'));
        },
      }),
      { status: 200 }
    );
    const { gw } = gateway({ fetchImpl: vi.fn(async () => broken) as unknown as typeof fetch });
    const out = sink();
    gw.handle(DEVICE, chat(1), out);
    await out.done;
    expect(out.status).toBe(200);
    expect(out.text()).toBe('data: partial');
    expect(out.error).toBe('The model server stopped mid-reply.');

    const { gw: down } = gateway({
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const refused = sink();
    down.handle(DEVICE, chat(1), refused);
    await refused.done;
    expect(refused.status).toBe(502);
  });

  it('stops a disconnected device’s requests, and refuses queued ones on close', async () => {
    const { calls, fetchImpl } = heldFetch();
    const { gw } = gateway({ fetchImpl });
    const [a, b] = [sink(), sink()];
    gw.handle(DEVICE, chat(1), a);
    gw.handle(DEVICE, chat(2), b);
    gw.dropPeer(DEVICE);
    await flush();
    // Both were the disconnected device's: nothing more is fetched and nobody is answered.
    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect([a.ended, b.ended]).toEqual([false, false]);

    const [c, d] = [sink(), sink()];
    gw.handle(DEVICE, chat(3), c);
    gw.handle(DEVICE, chat(4), d);
    gw.close();
    await d.done;
    expect(d.status).toBe(503);
    expect(calls[1].init.signal?.aborted).toBe(true);
    const after = sink();
    gw.handle(DEVICE, chat(5), after);
    await after.done;
    expect(after.status).toBe(503);
  });

  it('records each request’s path through the gateway, with counts and timings but no content', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const fetchImpl = vi.fn(async () => streamed(['data: one\n\n', 'data: two\n\n'])) as unknown as typeof fetch;
    const { gw } = gateway({ fetchImpl, diag: (event, data) => events.push([event, data]) });
    const out = sink();
    gw.handle(DEVICE, chat(4), out);
    await out.done;
    const refused = sink();
    gw.handle('e'.repeat(64), chat(5), refused);
    await refused.done;

    expect(events.map(([event]) => event)).toEqual([
      'gateway.request',
      'gateway.queued',
      'gateway.start',
      'gateway.upstream-head',
      'gateway.done',
      'gateway.request',
      'gateway.refused',
    ]);
    expect(Object.fromEntries(events.slice(0, 5))).toMatchObject({
      'gateway.queued': { id: 4, model: 'qwen3-8b', messages: 1, ahead: 0 },
      'gateway.done': { id: 4, status: 200, bytes: 22, chunks: 2, firstChunkMs: expect.any(Number) },
    });
    expect(events[6][1]).toMatchObject({ status: 403, reason: 'not-member' });
    expect(JSON.stringify(events)).not.toContain('secret prompt');
    expect(JSON.stringify(events)).not.toContain('data: one');
  });
});

describe('metering', () => {
  const chat = (id: number): GatewayRequest => ({
    id,
    circle: CIRCLE,
    method: 'POST',
    path: '/v1/chat/completions',
    body: JSON.stringify({ model: 'qwen3-8b', messages: [] }),
  });
  const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  const deps = (fetchImpl: typeof fetch, extra: Partial<InferenceGatewayDeps> = {}): InferenceGatewayDeps => ({
    offerFor: () => offer,
    memberFor: () => MEMBER,
    upstream: () => ({ baseUrl: 'http://127.0.0.1:1234/v1' }),
    fetchImpl,
    ...extra,
  });
  const today = () => localDay(new Date());

  it('counts requests and tokens per member, from JSON and from a stream', async () => {
    const onUsage = vi.fn();
    const stream = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\ndata: [DONE]\n\n';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply('{"choices":[],"usage":{"total_tokens":30}}'))
      .mockResolvedValueOnce(reply(stream));
    const gateway = new InferenceGateway(deps(fetchImpl as unknown as typeof fetch, { onUsage }));
    const first = sink();
    gateway.handle(DEVICE, chat(1), first);
    await first.done;
    const second = sink();
    gateway.handle(DEVICE, chat(2), second);
    await second.done;
    await flush();
    expect(onUsage.mock.lastCall?.[0]).toEqual({ day: today(), counts: { [MEMBER]: { requests: 2, tokens: 42 } } });
    expect(onUsage.mock.lastCall?.[1]).toEqual({ running: null, queued: [] });
  });

  it('doesn’t take a reply’s words for its usage', async () => {
    const onUsage = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(reply(JSON.stringify({ choices: [{ message: { content: '"total_tokens": 99' } }] })));
    const gateway = new InferenceGateway(deps(fetchImpl as unknown as typeof fetch, { onUsage }));
    const out = sink();
    gateway.handle(DEVICE, chat(1), out);
    await out.done;
    await flush();
    expect(onUsage.mock.lastCall?.[0].counts[MEMBER]).toEqual({ requests: 1, tokens: 0 });
  });

  it('keeps today’s counts from main and ignores yesterday’s', () => {
    const gateway = new InferenceGateway(
      deps(vi.fn() as unknown as typeof fetch, { usage: { day: today(), counts: { [MEMBER]: { requests: 3, tokens: 0 } } } })
    );
    gateway.setLimits({ everyone: { requestsPerDay: 3 }, members: {} });
    const over = sink();
    gateway.handle(DEVICE, chat(1), over);
    expect(over.status).toBe(429);

    const fresh = new InferenceGateway(
      deps(vi.fn().mockReturnValue(new Promise(() => undefined)) as unknown as typeof fetch, {
        usage: { day: '2000-01-01', counts: { [MEMBER]: { requests: 3, tokens: 0 } } },
      })
    );
    fresh.setLimits({ everyone: { requestsPerDay: 3 }, members: {} });
    const allowed = sink();
    fresh.handle(DEVICE, chat(1), allowed);
    expect(allowed.status).toBe(0);
    fresh.close();
  });

  it('answers 429 before any reply once a daily limit is used, without calling the server', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => reply('{"usage":{"total_tokens":100}}'));
    const gateway = new InferenceGateway(deps(fetchImpl as unknown as typeof fetch));
    gateway.setLimits({ everyone: { tokensPerDay: 100 }, members: {} });
    const first = sink();
    gateway.handle(DEVICE, chat(1), first);
    await first.done;
    await flush();
    const second = sink();
    gateway.handle(DEVICE, chat(2), second);
    expect(second.status).toBe(429);
    expect(second.text()).toContain('today’s tokens');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts queued requests against the daily limit and the limit on requests at once', () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => undefined));
    const daily = new InferenceGateway(deps(fetchImpl as unknown as typeof fetch));
    daily.setLimits({ everyone: { requestsPerDay: 2 }, members: {} });
    daily.handle(DEVICE, chat(1), sink());
    daily.handle(DEVICE, chat(2), sink());
    const dailyOver = sink();
    daily.handle(DEVICE, chat(3), dailyOver);
    expect(dailyOver.status).toBe(429);
    daily.close();

    const atOnce = new InferenceGateway(deps(fetchImpl as unknown as typeof fetch));
    atOnce.setLimits({ everyone: { concurrent: 1 }, members: {} });
    atOnce.handle(DEVICE, chat(1), sink());
    const concurrentOver = sink();
    atOnce.handle(DEVICE, chat(2), concurrentOver);
    expect(concurrentOver.status).toBe(429);
    atOnce.close();
  });

  it('lets a member’s own limit replace the limit for everyone', () => {
    const fetchImpl = vi.fn().mockReturnValue(new Promise(() => undefined));
    const gateway = new InferenceGateway(deps(fetchImpl as unknown as typeof fetch));
    gateway.setLimits({ everyone: { requestsPerDay: 1 }, members: { [MEMBER]: {} } });
    gateway.handle(DEVICE, chat(1), sink());
    const second = sink();
    gateway.handle(DEVICE, chat(2), second);
    expect(second.status).toBe(0);
    gateway.close();
  });

  it('gives a request back when the server refuses it or it never started', async () => {
    const onUsage = vi.fn();
    const held = heldFetch();
    const gateway = new InferenceGateway(deps(held.fetchImpl, { onUsage }));
    const refused = sink();
    gateway.handle(DEVICE, chat(1), refused);
    const queued = sink();
    gateway.handle(DEVICE, chat(2), queued);
    gateway.cancel(DEVICE, 2);
    expect(onUsage.mock.lastCall?.[0].counts[MEMBER].requests).toBe(1);
    await flush();
    held.calls[0].release(reply('{}', 500));
    await refused.done;
    await flush();
    expect(onUsage.mock.lastCall?.[0].counts[MEMBER].requests).toBe(0);
  });

  it('reports who is running and who is waiting', () => {
    const onUsage = vi.fn();
    const held = heldFetch();
    const gateway = new InferenceGateway(deps(held.fetchImpl, { onUsage }));
    gateway.handle(DEVICE, chat(1), sink());
    gateway.handle(DEVICE, chat(2), sink());
    expect(onUsage.mock.lastCall?.[1]).toEqual({ running: MEMBER, queued: [MEMBER] });
    gateway.close();
  });
});
