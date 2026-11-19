import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedSessionInference } from '../../../../shared/types/hermesChat';
import type { LlmConnection } from '../../onboarding/OpenAiOnboardingStore';
import type { ChainPlan } from '../inferenceChainService';
import type { RouterChain } from '../router/chainRouter';

// The real modules read stores and Circles; the helper takes them as deps, so stand-ins do.
vi.mock('../../assistant/hermes/resolveSessionInference', () => ({ resolveAppDefault: vi.fn() }));
vi.mock('../inferenceChainService', () => ({ planAppInferenceChain: vi.fn() }));
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({ getSlotLlmConnection: vi.fn() }));
vi.mock('../inferenceRouterService', () => ({ ensureInferenceRouter: vi.fn(), routeOnce: vi.fn() }));

const { createAskChatModelOnce } = await import('../askChatModelOnce');
type Deps = Parameters<typeof createAskChatModelOnce>[0];

const resolved: ResolvedSessionInference = {
  slot: 'openrouter',
  modelId: 'vendor/model',
  providerDisplayName: 'OpenRouter',
  provenance: 'app-default',
  configured: true,
  needsRestart: false,
};

const connection: LlmConnection = {
  endpointUrl: 'https://cloud.test/api/v1/',
  apiKey: 'sk-test',
  modelId: 'vendor/model',
  authScheme: 'bearer',
  extraHeaders: { 'X-Title': 'App' },
};

const routedChain: RouterChain = {
  entries: [
    { entry: { slot: 'local' }, key: 'local:', stale: null, private: true },
    { entry: { slot: 'openrouter' }, key: 'openrouter:', stale: null, private: false },
  ],
  upstreams: {
    'local:': { baseUrl: 'http://local.test/v1', modelId: 'qwen' },
    'openrouter:': { baseUrl: 'https://cloud.test/api/v1', apiKey: 'sk-test', modelId: 'vendor/model' },
  },
  modelId: 'qwen',
};

const encoder = new TextEncoder();

/** An SSE reply of the given chunks, then `[DONE]`; `hang` leaves the stream open instead. */
function sse(chunks: unknown[], options: { hang?: boolean; status?: number; headers?: Record<string, string> } = {}) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (options.hang) return;
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: options.status ?? 200, headers: { 'Content-Type': 'text/event-stream', ...options.headers } }
  );
}

const content = (text: string) => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: null as string | null }] });
const reasoning = (text: string) => ({ choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null as string | null }] });
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

function deps(overrides: Partial<Deps> = {}, reply: () => Response | Promise<Response> = () => sse([content('hi'), finish('stop')])) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const release = vi.fn();
  const routeOnce = vi.fn((_key: string, _chain: RouterChain) => release);
  let clock = 1_000;
  const base: Deps = {
    resolve: async () => resolved,
    plan: async (): Promise<ChainPlan> => ({ kind: 'direct' }),
    connection: async () => connection,
    router: { ensure: async () => ({ port: 4321, token: 'router-token' }), routeOnce },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return reply();
    }) as typeof fetch,
    now: () => (clock += 250),
  };
  return { deps: { ...base, ...overrides }, calls, release, routeOnce };
}

const messages = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'ask' },
];
const options = { temperature: 0.7, maxTokens: 12_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe('askChatModelOnce', () => {
  it('a direct plan posts to the slot’s endpoint with its auth scheme and extra headers', async () => {
    const run = deps();
    const result = await createAskChatModelOnce(run.deps)(messages, options);
    expect(result).toEqual({ ok: true, text: 'hi', finish: 'stop', tokens: null, ms: 250, slot: 'openrouter' });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].url).toBe('https://cloud.test/api/v1/chat/completions');
    expect(run.calls[0].init.method).toBe('POST');
    expect(run.calls[0].init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
      'X-Title': 'App',
    });
    expect(run.calls[0].body).toEqual({
      model: 'vendor/model',
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.7,
      max_tokens: 12_000,
    });
    expect(run.routeOnce).not.toHaveBeenCalled();
  });

  it('a direct plan sends the Authorization header Inference verified the connection with', async () => {
    const cases: Array<[Partial<LlmConnection>, string]> = [
      [{ authScheme: 'bearer' }, 'Bearer sk-test'],
      [{ authScheme: 'api-key' }, 'Api-Key sk-test'],
      [{ authScheme: 'bearer', provider: 'baseten' }, 'Api-Key sk-test'],
    ];
    for (const [extra, header] of cases) {
      const run = deps({ connection: async () => ({ ...connection, extraHeaders: undefined, ...extra }) });
      await createAskChatModelOnce(run.deps)(messages, options);
      expect(run.calls[0].init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: header });
    }
  });

  it('a routed plan posts to the router with its token and a once- session key, and releases it after', async () => {
    const run = deps({ plan: async () => ({ kind: 'routed', chain: routedChain, slowestUrl: 'http://local.test/v1' }) }, () =>
      sse([content('ok'), finish('stop')], { headers: { 'x-boundary-served': 'local:' } })
    );
    const result = await createAskChatModelOnce(run.deps)(messages, options);
    expect(result).toMatchObject({ ok: true, text: 'ok', slot: 'local' });
    expect(run.calls[0].url).toBe('http://127.0.0.1:4321/v1/chat/completions');
    const headers = run.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer router-token');
    expect(headers['x-boundary-session']).toMatch(/^once-[0-9a-f]{16}$/);
    expect(run.routeOnce).toHaveBeenCalledWith(headers['x-boundary-session'], routedChain);
    expect(run.calls[0].body).toMatchObject({ model: 'qwen', stream: true });
    expect(run.release).toHaveBeenCalledOnce();
  });

  it('a routed plan releases its key after a failure too', async () => {
    const run = deps({ plan: async () => ({ kind: 'routed', chain: routedChain, slowestUrl: '' }) }, () => {
      throw new TypeError('fetch failed');
    });
    const result = await createAskChatModelOnce(run.deps)(messages, options);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(run.release).toHaveBeenCalledOnce();
  });

  it('keeps only content deltas', async () => {
    const run = deps({}, () => sse([reasoning('thinking'), content('a'), reasoning('more'), content('b'), finish('stop')]));
    const result = await createAskChatModelOnce(run.deps)(messages, options);
    expect(result).toMatchObject({ ok: true, text: 'ab' });
  });

  it('fires onProgress on reasoning deltas too', async () => {
    const onProgress = vi.fn();
    const run = deps({}, () => sse([reasoning('thinking'), reasoning('more'), content('a'), finish('stop')]));
    await createAskChatModelOnce(run.deps)(messages, { ...options, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it('reports a length finish', async () => {
    const run = deps({}, () => sse([content('cut'), finish('length')]));
    expect(await createAskChatModelOnce(run.deps)(messages, options)).toMatchObject({ ok: true, finish: 'length' });
  });

  it('reads usage tokens from the last chunk', async () => {
    const usage = { choices: [] as unknown[], usage: { prompt_tokens: 900, completion_tokens: 321, total_tokens: 1221 } };
    const run = deps({}, () => sse([content('x'), finish('stop'), usage]));
    expect(await createAskChatModelOnce(run.deps)(messages, options)).toMatchObject({ ok: true, tokens: 321 });
  });

  it('gives cancelled when aborted mid-reply', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());
    const run = deps({}, () => sse([content('a')], { hang: true }));
    const result = await createAskChatModelOnce(run.deps)(messages, { ...options, signal: controller.signal, onProgress });
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('gives cancelled without sending when already aborted', async () => {
    const run = deps();
    const result = await createAskChatModelOnce(run.deps)(messages, { ...options, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(run.calls).toHaveLength(0);
  });

  it('gives cancelled without sending when aborted while planning or starting the router', async () => {
    for (const stage of ['plan', 'router'] as const) {
      const controller = new AbortController();
      const routed = async (): Promise<ChainPlan> => ({ kind: 'routed', chain: routedChain, slowestUrl: '' });
      const run = deps(
        stage === 'plan'
          ? {
              plan: async () => {
                controller.abort();
                return routed();
              },
            }
          : { plan: routed },
        () => sse([content('a'), finish('stop')])
      );
      if (stage === 'router') {
        run.deps.router.ensure = async () => {
          controller.abort();
          return { port: 4321, token: 'router-token' };
        };
      }
      const result = await createAskChatModelOnce(run.deps)(messages, { ...options, signal: controller.signal });
      expect(result).toMatchObject({ ok: false, reason: 'cancelled' });
      expect(run.calls).toHaveLength(0);
      expect(run.release).toHaveBeenCalledOnce();
    }
  });

  it('gives timeout at the cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const run = deps({}, () => sse([content('a')], { hang: true }));
    const pending = createAskChatModelOnce(run.deps)(messages, { ...options, capMs: 600_000 });
    await vi.advanceTimersByTimeAsync(599_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout', problem: expect.stringMatching(/\.$/) });
  });

  it('gives no-model with no app default, or one that isn’t set up', async () => {
    const unset: Array<Deps['resolve']> = [async () => null, async () => ({ ...resolved, configured: false })];
    for (const resolve of unset) {
      const run = deps({ resolve });
      const result = await createAskChatModelOnce(run.deps)(messages, options);
      expect(result).toMatchObject({ ok: false, reason: 'no-model' });
      expect(run.calls).toHaveLength(0);
    }
  });

  it('gives refused with the plan’s sentence', async () => {
    const run = deps({ plan: async () => ({ kind: 'refused', error: 'No added provider serves m now.' }) });
    expect(await createAskChatModelOnce(run.deps)(messages, options)).toEqual({
      ok: false,
      reason: 'refused',
      problem: 'No added provider serves m now.',
    });
    const offline = deps({
      plan: async () => ({ kind: 'routed', chain: routedChain, slowestUrl: '', offline: 'Bo’s model is offline.' }),
    });
    expect(await createAskChatModelOnce(offline.deps)(messages, options)).toEqual({
      ok: false,
      reason: 'refused',
      problem: 'Bo’s model is offline.',
    });
    expect(offline.routeOnce).not.toHaveBeenCalled();
    expect(offline.calls).toHaveLength(0);
  });

  it('gives status on a non-2xx answer', async () => {
    const run = deps({}, () => new Response('{"error":{"message":"nope"}}', { status: 401 }));
    expect(await createAskChatModelOnce(run.deps)(messages, options)).toMatchObject({
      ok: false,
      reason: 'status',
      problem: expect.stringContaining('401'),
    });
  });

  it('passes on the router’s own sentence when no model in the chain answered', async () => {
    const message = 'No model in the inference chain answered (local: unreachable).';
    const run = deps({ plan: async () => ({ kind: 'routed', chain: routedChain, slowestUrl: '' }) }, () =>
      new Response(JSON.stringify({ error: { message, type: 'boundary_router_error' } }), { status: 503 })
    );
    expect(await createAskChatModelOnce(run.deps)(messages, options)).toEqual({ ok: false, reason: 'status', problem: message });
  });
});
