import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceChainEntryState } from '../../../../../shared/types/inferenceChain';
import {
  ROUTER_SERVED_HEADER,
  ROUTER_SESSION_HEADER,
  startChainRouter,
  type ChainRouter,
  type RouterChain,
  type RouterServed,
} from '../chainRouter';

const TOKEN = 'router-token-for-tests';

function state(key: string, extra: Partial<InferenceChainEntryState> = {}): InferenceChainEntryState {
  return { entry: { slot: 'local' }, key, stale: null, private: true, ...extra };
}

const chain: RouterChain = {
  entries: [state('peer'), state('local'), state('cloud', { private: false })],
  upstreams: {
    peer: { baseUrl: 'http://peer.test/v1', modelId: 'qwen3-32b' },
    local: { baseUrl: 'http://local.test/v1/', modelId: 'qwen3:14b' },
    cloud: { baseUrl: 'http://cloud.test/api/v1', apiKey: 'sk-real', modelId: 'anthropic/claude' },
  },
  modelId: 'qwen3-32b',
  contextLength: 32_768,
};

type Upstream = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

/** A fake fetch keyed by upstream host; records what each upstream was sent. */
function upstreams(handlers: Record<string, Upstream>) {
  const calls: Array<{ host: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ host: url.host, body, init: init ?? {} });
    const handler = handlers[url.host];
    if (!handler) throw new TypeError('fetch failed');
    return handler(body, init ?? {});
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const ok = (text: string) => () => new Response(JSON.stringify({ text }), { status: 200 });

let router: ChainRouter | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await router?.close();
  router = null;
});

async function start(options: Partial<Parameters<typeof startChainRouter>[0]> = {}) {
  router = await startChainRouter({ token: TOKEN, getChain: () => chain, ...options });
  return router;
}

function post(
  messages: Array<{ role: string; content?: string }>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`http://127.0.0.1:${router!.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'qwen3-32b', messages, stream: false }),
  });
}

const userTurn = [{ role: 'user', content: 'hi' }];
const toolStep = [...userTurn, { role: 'assistant' }, { role: 'tool', content: 'result' }];

describe('chain router', () => {
  it('refuses requests without the token or with an Origin', async () => {
    await start();
    const url = `http://127.0.0.1:${router!.port}/v1/models`;
    expect((await fetch(url)).status).toBe(401);
    const fromPage = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.test' } });
    expect(fromPage.status).toBe(403);
  });

  it('reports the configured model and the chain context', async () => {
    await start();
    const res = await fetch(`http://127.0.0.1:${router!.port}/v1/models`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(await res.json()).toEqual({
      object: 'list',
      data: [{ id: 'qwen3-32b', object: 'model', owned_by: 'boundary', context_length: 32_768 }],
    });
  });

  it('serves from the first entry and rewrites nothing it does not own', async () => {
    const fake = upstreams({ 'peer.test': ok('from peer') });
    await start({ fetchImpl: fake.fetchImpl });
    const res = await post(userTurn);
    expect(res.status).toBe(200);
    expect(res.headers.get(ROUTER_SERVED_HEADER)).toBe('peer');
    expect(await res.json()).toEqual({ text: 'from peer' });
    expect(fake.calls[0].body).toMatchObject({ model: 'qwen3-32b', stream: false, messages: userTurn });
  });

  it('falls back on unreachable, 429 and 5xx, rewriting the model and key per entry', async () => {
    const served: RouterServed[] = [];
    const fake = upstreams({
      'local.test': () => new Response('busy', { status: 429 }),
      'cloud.test': ok('from cloud'),
    });
    await start({ fetchImpl: fake.fetchImpl, onServed: (s) => served.push(s) });
    const res = await post(userTurn, { [ROUTER_SESSION_HEADER]: 's1' });
    expect(res.headers.get(ROUTER_SERVED_HEADER)).toBe('cloud');
    expect(fake.calls.map((c) => c.host)).toEqual(['peer.test', 'local.test', 'cloud.test']);
    expect(fake.calls[1].init.headers).not.toHaveProperty('Authorization');
    expect(fake.calls[2].body.model).toBe('anthropic/claude');
    expect(fake.calls[2].init.headers).toMatchObject({ Authorization: 'Bearer sk-real' });
    expect(fake.calls[0].init.headers).not.toHaveProperty('Authorization');
    expect(served).toEqual([
      expect.objectContaining({ sessionKey: 's1', entryKey: 'cloud', slot: 'local', modelId: 'anthropic/claude', fellBack: true }),
    ]);
  });

  it('passes a non-fallback refusal through instead of trying further', async () => {
    const fake = upstreams({ 'peer.test': () => new Response('{"error":"bad"}', { status: 400 }) });
    await start({ fetchImpl: fake.fetchImpl });
    const res = await post(userTurn);
    expect(res.status).toBe(400);
    expect(res.headers.get(ROUTER_SERVED_HEADER)).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });

  it('answers 503 naming each attempt when the chain is exhausted', async () => {
    const fake = upstreams({ 'cloud.test': () => new Response('down', { status: 502 }) });
    await start({ fetchImpl: fake.fetchImpl });
    const res = await post(userTurn);
    // The last refusal was a fallback status, so it is reported rather than passed through.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('peer: unreachable');
    expect(body.error.message).toContain('cloud: HTTP 502');
  });

  it('keeps a session on the entry that served it until a new turn', async () => {
    const handlers: Record<string, Upstream> = { 'local.test': ok('local'), 'cloud.test': ok('cloud') };
    const fake = upstreams(handlers);
    await start({ fetchImpl: fake.fetchImpl });
    const session = { [ROUTER_SESSION_HEADER]: 's1' };

    await post(userTurn, session); // peer unreachable → local serves
    handlers['peer.test'] = ok('peer');
    fake.calls.length = 0;
    const step = await post(toolStep, session);
    expect(step.headers.get(ROUTER_SERVED_HEADER)).toBe('local');
    expect(fake.calls.map((c) => c.host)).toEqual(['local.test']);

    const next = await post([...toolStep, { role: 'user', content: 'again' }], session);
    expect(next.headers.get(ROUTER_SERVED_HEADER)).toBe('peer');
  });

  it('falls back when an entry sends no headers in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let reached!: () => void;
    const peerReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const fake = upstreams({
      'peer.test': (_body, init) =>
        new Promise<Response>((_resolve, reject) => {
          reached();
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      'local.test': ok('local'),
    });
    await start({ fetchImpl: fake.fetchImpl, headerTimeoutMs: 10_000 });
    const pending = post(userTurn);
    await peerReached;
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(res.headers.get(ROUTER_SERVED_HEADER)).toBe('local');
  });

  it('skips entries without an upstream and answers 503 with no chain', async () => {
    const fake = upstreams({ 'cloud.test': ok('cloud') });
    const partial: RouterChain = { ...chain, upstreams: { cloud: chain.upstreams.cloud } };
    await start({ fetchImpl: fake.fetchImpl, getChain: () => partial });
    expect((await post(userTurn)).headers.get(ROUTER_SERVED_HEADER)).toBe('cloud');
    expect(fake.calls.map((c) => c.host)).toEqual(['cloud.test']);
    await router!.close();

    router = await startChainRouter({ token: TOKEN, getChain: () => null });
    expect((await post(userTurn)).status).toBe(503);
  });

  it('streams the served reply through', async () => {
    const encoder = new TextEncoder();
    const fake = upstreams({
      'peer.test': () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        ),
    });
    await start({ fetchImpl: fake.fetchImpl });
    const res = await post(userTurn);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
  });

  describe('shared-model entries', () => {
    const PEER = { circleId: 'c'.repeat(64), providerId: 'a'.repeat(64) };
    const shared: RouterChain = {
      ...chain,
      entries: [state('shared', { entry: { slot: 'peer', modelId: 'qwen3-8b', peer: PEER }, private: false }), state('local')],
      upstreams: {
        shared: { baseUrl: '', modelId: 'qwen3-8b', peer: PEER },
        local: chain.upstreams.local,
      },
    };

    it('serves through the Circles network with the entry’s model, never by URL', async () => {
      const fake = upstreams({ 'local.test': ok('local') });
      const peerFetch = vi.fn(async () => new Response('{"text":"shared"}', { status: 200 }));
      const served: RouterServed[] = [];
      await start({ fetchImpl: fake.fetchImpl, peerFetch, getChain: () => shared, onServed: (s) => served.push(s) });
      const res = await post(userTurn);
      expect(res.headers.get(ROUTER_SERVED_HEADER)).toBe('shared');
      expect(await res.json()).toEqual({ text: 'shared' });
      expect(peerFetch).toHaveBeenCalledWith(PEER, expect.any(String), expect.any(AbortSignal));
      expect(JSON.parse(peerFetch.mock.calls[0][1] as string)).toMatchObject({ model: 'qwen3-8b', messages: userTurn });
      expect(fake.calls).toEqual([]);
      expect(served[0]).toMatchObject({ slot: 'peer', modelId: 'qwen3-8b', fellBack: false });
    });

    it('falls back when the provider is unreachable or over quota', async () => {
      const fake = upstreams({ 'local.test': ok('local') });
      for (const peerFetch of [
        vi.fn(async () => {
          throw new Error('The provider is not connected.');
        }),
        vi.fn(async () => new Response('{"error":"quota"}', { status: 429 })),
      ]) {
        await start({ fetchImpl: fake.fetchImpl, peerFetch, getChain: () => shared });
        expect((await post(userTurn)).headers.get(ROUTER_SERVED_HEADER)).toBe('local');
        await router!.close();
        router = null;
      }
    });

    it('treats a shared entry as unreachable without a way to reach Circles', async () => {
      const fake = upstreams({ 'local.test': ok('local') });
      await start({ fetchImpl: fake.fetchImpl, getChain: () => shared });
      expect((await post(userTurn)).headers.get(ROUTER_SERVED_HEADER)).toBe('local');
      expect(fake.calls.map((c) => c.host)).toEqual(['local.test']);
    });
  });

  it('records each request’s attempts with timings, and the reply’s size, without content', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    let replied: () => void = () => undefined;
    const replyLogged = new Promise<void>((resolve) => (replied = resolve));
    const fake = upstreams({ 'local.test': ok('the answer'), 'peer.test': () => new Response('busy', { status: 503 }) });
    await start({
      fetchImpl: fake.fetchImpl,
      diag: (event, data) => {
        events.push([event, data]);
        if (event === 'router.reply') replied();
      },
    });
    const res = await post(userTurn, { [ROUTER_SESSION_HEADER]: 'session-1234567890' });
    await res.text();
    await replyLogged;

    const request = events.find(([event]) => event === 'router.request')![1];
    expect(request).toMatchObject({
      session: 'session-',
      newTurn: true,
      messages: 1,
      served: 'local',
      fellBack: true,
      attempts: [
        { key: 'peer', outcome: 'status', status: 503, ms: expect.any(Number) },
        { key: 'local', outcome: 'served', ms: expect.any(Number) },
      ],
    });
    expect(events.find(([event]) => event === 'router.reply')![1]).toMatchObject({ served: 'local', status: 200, how: 'end', bytes: 21 });
    expect(JSON.stringify(events)).not.toContain('the answer');
    expect(JSON.stringify(events)).not.toContain('"hi"');
  });

  it('records how many requests each entry had when a request arrived, until each reply ends', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let finishFirst: () => void = () => undefined;
    let replied: () => void = () => undefined;
    let replyLogged = new Promise<void>((resolve) => (replied = resolve));
    const fake = upstreams({
      'peer.test': (body) =>
        (body.messages as unknown[]).length === 2
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
                  finishFirst = () => controller.close();
                },
              }),
              { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
            )
          : new Response('{}', { status: 200 }),
    });
    await start({
      fetchImpl: fake.fetchImpl,
      diag: (event, data) => {
        if (event === 'router.request') seen.push(data);
        if (event === 'router.reply') replied();
      },
    });

    const long = await post([...userTurn, ...userTurn]);
    const longBody = long.text();
    await (await post(userTurn)).text();
    await replyLogged;
    finishFirst();
    await longBody;
    replyLogged = new Promise<void>((resolve) => (replied = resolve));
    await (await post(userTurn)).text();
    await replyLogged;

    expect(seen.map((request) => request.inFlight)).toEqual([{}, { peer: 1 }, {}]);
  });

  it('frees an entry that refused, so it does not count against later requests', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const fake = upstreams({ 'peer.test': () => new Response('busy', { status: 503 }), 'local.test': ok('fine') });
    await start({
      fetchImpl: fake.fetchImpl,
      diag: (event, data) => {
        if (event === 'router.request') seen.push(data);
      },
    });
    await (await post(userTurn)).text();
    await (await post(userTurn, { [ROUTER_SESSION_HEADER]: 'other' })).text();
    expect(seen).toHaveLength(2);
    expect(seen[1].inFlight).not.toHaveProperty('peer');
  });
});
