import { sha256, sha384 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNearAdapter, mapNearError } from '../nearAdapter';
import type { NearVerifierDeps } from '../nearAttestation';
import { decryptField, encryptField, newClientKeys, type NearClientKeys } from '../nearCrypto';

/**
 * The adapter against a fake NEAR. Reports are built per request so the quote's report data
 * holds the model key and the nonce the adapter sent; the fake verifier reads that report data
 * back out of `intel_quote` and accepts the GPU evidence. Everything else in
 * `verifyModelAttestation` (key and nonce binding, MRCONFIGID, RTMR3 replay, GPU nonce) runs
 * for real.
 */

const BASE = 'https://cloud-api.near.ai/v1';
const MODEL = 'z-ai/glm-5.3-flash';
const OTHER_MODEL = 'Qwen/Qwen3.8-27B';
const CLOSED_MODEL = 'anthropic/claude-haiku-4-5';
const API_KEY = 'sk-SECRETMARKER';
const ERROR_EVENT = 'data: {"error":{"message":"The provider’s reply couldn’t be read."}}\n\n';

const COMPOSE = 'services:\n  model:\n    image: vllm\n';
const COMPOSE_HASH = sha256(utf8ToBytes(COMPOSE));

function dstackDigest(type: number, event: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  new DataView(typeBytes.buffer).setUint32(0, type, true);
  const colon = utf8ToBytes(':');
  return sha384(concatBytes(typeBytes, colon, utf8ToBytes(event), colon, payload));
}

const RTMR3 = sha384(concatBytes(new Uint8Array(48), dstackDigest(0x08000001, 'compose-hash', COMPOSE_HASH)));
const MRCONFIG = (() => {
  const out = new Uint8Array(48);
  out[0] = 1;
  out.set(COMPOSE_HASH, 1);
  return out;
})();

function attestation(modelName: string, keyHex: string, nonce: string): Record<string, unknown> {
  return {
    model_name: modelName,
    signing_algo: 'ed25519',
    signing_public_key: keyHex,
    request_nonce: nonce,
    // The fake verifier treats the quote as its report data.
    intel_quote: keyHex + nonce,
    nvidia_payload: JSON.stringify({ nonce, evidence_list: [], arch: 'HOPPER' }),
    event_log: [{ imr: 3, event_type: 0x08000001, event: 'compose-hash', event_payload: bytesToHex(COMPOSE_HASH), digest: '' }],
    info: { tcb_info: { app_compose: COMPOSE } },
  };
}

function fakeVerifier(overrides: Partial<NearVerifierDeps> = {}): NearVerifierDeps & { verifyQuote: ReturnType<typeof vi.fn> } {
  return {
    verifyQuote: vi.fn(async (quoteHex: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      return { status: 'UpToDate', reportData: hexToBytes(quoteHex), mrConfigId: MRCONFIG, rtmr3: RTMR3, debug: false };
    }),
    verifyGpu: vi.fn(async (payload: unknown) => ({ verdict: true, nonce: (payload as { nonce: string }).nonce })),
    ...overrides,
  } as NearVerifierDeps & { verifyQuote: ReturnType<typeof vi.fn> };
}

interface ChatCall {
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

type ChatHandler = (call: ChatCall) => Response | Promise<Response>;

/** A fake NEAR. `modelKey` is the enclave's key; `report` can replace the report for a model. */
function fakeNear(opts: {
  modelKey?: NearClientKeys;
  chat?: ChatHandler;
  report?: (model: string, nonce: string, keyHex: string) => unknown;
  models?: unknown;
}) {
  const modelKey = opts.modelKey ?? newClientKeys();
  const chats: ChatCall[] = [];
  const reports: { model: string; nonce: string }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (url.href.startsWith(`${BASE}/attestation/report`)) {
      const model = url.searchParams.get('model')!;
      const nonce = url.searchParams.get('nonce')!;
      reports.push({ model, nonce });
      const report = opts.report
        ? opts.report(model, nonce, modelKey.publicKeyHex)
        : { gateway_attestation: {}, model_attestations: [attestation(model, modelKey.publicKeyHex, nonce)] };
      return report instanceof Response ? report : Response.json(report);
    }
    if (url.href === `${BASE}/models`) return Response.json(opts.models ?? { data: [] });
    if (url.href === `${BASE}/chat/completions` && init?.method === 'POST') {
      const call = {
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        signal: init.signal ?? undefined,
      };
      chats.push(call);
      return (opts.chat ?? okChat)(call);
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, fetchMock: fetchImpl, modelKey, chats, reports };
}

/** The client key a chat call asked replies to be encrypted to. */
function clientKey(call: ChatCall): string {
  return call.headers['x-client-pub-key'];
}

function okChat(call: ChatCall): Response {
  return Response.json({
    id: 'c1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: encryptField('ok', clientKey(call)) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  });
}

function sse(events: string[]): Response {
  return new Response(events.map((e) => `data: ${e}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const signal = (): AbortSignal => new AbortController().signal;
const chatBody = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello there' }], ...extra });

function adapterFor(near: ReturnType<typeof fakeNear>, extra: Partial<Parameters<typeof createNearAdapter>[0]> = {}) {
  return createNearAdapter({ apiKey: API_KEY, models: [MODEL, OTHER_MODEL], fetch: near.fetch, verifier: fakeVerifier(), ...extra });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listModels', () => {
  it('lists models with per-million prices, context and precision', async () => {
    const near = fakeNear({
      models: {
        data: [
          {
            id: MODEL,
            context_length: 131072,
            quantization: 'fp8',
            pricing: { prompt: '0.00000004', completion: '0.00000016', input_cache_read: '0.00000001' },
          },
          { id: OTHER_MODEL, context_length: 32768, quantization: 'bf16', pricing: { prompt: '0.0000003', completion: '0.0000012' } },
          { id: 'a/fp4', quantization: 'fp4', pricing: { prompt: '0.000001', completion: '0.000002' } },
          { id: 'a/nvfp4', quantization: 'nvfp4' },
          { id: 'a/none' },
          { id: CLOSED_MODEL, context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000005' } },
        ],
      },
    });
    const adapter = adapterFor(near, { models: [MODEL, OTHER_MODEL, 'a/fp4', 'a/nvfp4', 'a/none'] });
    const offers = await adapter.listModels(signal());
    expect(offers).toEqual([
      { providerModelId: MODEL, contextLength: 131072, precision: 'fp8', price: { inputPerM: 0.04, cachedInputPerM: 0.01, outputPerM: 0.16 } },
      { providerModelId: OTHER_MODEL, contextLength: 32768, precision: 'bf16', price: { inputPerM: 0.3, cachedInputPerM: null, outputPerM: 1.2 } },
      { providerModelId: 'a/fp4', contextLength: null, precision: 'fp4', price: { inputPerM: 1, cachedInputPerM: null, outputPerM: 2 } },
      { providerModelId: 'a/nvfp4', contextLength: null, precision: 'fp4', price: null },
      { providerModelId: 'a/none', contextLength: null, precision: null, price: null },
    ]);
  });

  it('throws a fixed message when the list can’t be read', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('https://cloud-api.near.ai/v1/models?secret');
    }) as unknown as typeof fetch;
    const adapter = createNearAdapter({ apiKey: API_KEY, models: [MODEL], fetch: fetchImpl, verifier: fakeVerifier() });
    await expect(adapter.listModels(signal())).rejects.toThrow('NEAR’s model list couldn’t be reached.');
  });
});

describe('mapNearError', () => {
  it('maps errors', async () => {
    const none = new Headers();
    expect(mapNearError(401, '', none)).toEqual({ kind: 'bad-key' });
    expect(mapNearError(402, '', none)).toEqual({ kind: 'no-balance' });
    expect(mapNearError(429, '', new Headers({ 'Retry-After': '30' }))).toEqual({ kind: 'rate-limited', retryAfterMs: 30000 });
    expect(mapNearError(429, '{"error":{"type":"service_overloaded"}}', none)).toEqual({ kind: 'rate-limited' });
    expect(mapNearError(503, '', none)).toEqual({ kind: 'server', status: 503 });
    expect(mapNearError(400, '', none)).toEqual({ kind: 'server', status: 400 });
    // vLLM's wording behind NEAR's gateway, and OpenAI's code.
    const vllm = '{"error":{"message":"This model\'s maximum context length is 131072 tokens. However, you requested 140000 tokens.","code":400}}';
    expect(mapNearError(400, vllm, none)).toEqual({ kind: 'server', status: 400, contextOverflow: true });
    expect(mapNearError(400, '{"error":{"code":"context_length_exceeded"}}', none)).toEqual({ kind: 'server', status: 400, contextOverflow: true });
    expect(mapNearError(500, vllm, none)).toEqual({ kind: 'server', status: 500 });

    const thrown = fakeNear({
      chat: () => {
        throw new Error('connect ECONNREFUSED https://cloud-api.near.ai sk-SECRETMARKER');
      },
    });
    const result = await adapterFor(thrown).chat(chatBody(), signal());
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'chat' } });
  });

  it('maps a non-2xx chat head and bounds the error body it reads', async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const near = fakeNear({ chat: () => new Response(big, { status: 429, headers: { 'retry-after': '5' } }) });
    const result = await adapterFor(near).chat(chatBody(), signal());
    expect(result).toEqual({ ok: false, failure: { kind: 'rate-limited', retryAfterMs: 5000 } });
    expect(pulled).toBeLessThan(10);
  });
});

describe('chat', () => {
  it('attests before the first chat and pins the verified key', async () => {
    const near = fakeNear({});
    const result = await adapterFor(near).chat(chatBody(), signal());
    expect(result.ok).toBe(true);
    expect(near.reports).toHaveLength(1);
    expect(near.reports[0].model).toBe(MODEL);
    expect(near.chats).toHaveLength(1);
    const call = near.chats[0];
    expect(call.headers['x-model-pub-key']).toBe(near.modelKey.publicKeyHex);
    expect(call.headers['x-encrypt-all-fields']).toBe('true');
    expect(call.headers['x-encryption-version']).toBe('2');
    expect(call.headers['x-no-aliasing']).toBe('true');
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const message = (call.body.messages as { content: string }[])[0];
    expect(message.content).not.toContain('Hello');
    expect(decryptField(message.content, near.modelKey)).toBe('Hello there');
    if (result.ok === true) expect(await result.response.json()).toMatchObject({ choices: [{ message: { content: 'ok' } }] });
  });

  it('uses a fresh 32-byte nonce for each attestation', async () => {
    const near = fakeNear({});
    const adapter = adapterFor(near);
    await adapter.verifyAttestation(MODEL, signal());
    vi.advanceTimersByTime(61 * 1000);
    await adapter.verifyAttestation(MODEL, signal());
    expect(near.reports.map((r) => r.nonce)).toHaveLength(2);
    expect(near.reports[0].nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(near.reports[0].nonce).not.toBe(near.reports[1].nonce);
  });

  it('uses a new client keypair for each chat', async () => {
    const near = fakeNear({});
    const adapter = adapterFor(near);
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody(), signal());
    expect(clientKey(near.chats[0])).not.toBe(clientKey(near.chats[1]));
  });

  it('reuses the key for 30 minutes, then attests again', async () => {
    const near = fakeNear({});
    const adapter = adapterFor(near);
    await adapter.chat(chatBody(), signal());
    vi.advanceTimersByTime(29 * 60 * 1000);
    await adapter.chat(chatBody(), signal());
    expect(near.reports).toHaveLength(1);
    vi.advanceTimersByTime(60 * 1000);
    await adapter.chat(chatBody(), signal());
    expect(near.reports).toHaveLength(2);
    expect(near.chats).toHaveLength(3);
  });

  it('keeps keys per model', async () => {
    const near = fakeNear({});
    const adapter = adapterFor(near);
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody({ model: OTHER_MODEL }), signal());
    expect(near.reports.map((r) => r.model)).toEqual([MODEL, OTHER_MODEL]);
  });

  it('uses the key verifyAttestation verified', async () => {
    const near = fakeNear({});
    const adapter = adapterFor(near);
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: true });
    await adapter.chat(chatBody(), signal());
    expect(near.reports).toHaveLength(1);
  });

  it('verifyAttestation reuses a key checked in the last minute, as adding a provider does after checkKey', async () => {
    const near = fakeNear({});
    const adapter = adapterFor(near);
    expect(await adapter.checkKey(signal())).toEqual({ ok: true });
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: true });
    expect(near.reports).toHaveLength(1);
    vi.advanceTimersByTime(61 * 1000);
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: true });
    expect(near.reports).toHaveLength(2);
  });

  it('keeps the key after a chat refused for the account, and drops it after any other failure', async () => {
    for (const [status, reports] of [[402, 1], [401, 1], [429, 1], [400, 2], [503, 2]] as const) {
      const near = fakeNear({ chat: () => new Response('{"error":{}}', { status }) });
      const adapter = adapterFor(near);
      await adapter.chat(chatBody(), signal());
      await adapter.verifyAttestation(MODEL, signal());
      expect(near.reports, String(status)).toHaveLength(reports);
    }
  });

  it('keeps the cached key after a chat aborted while its reply is read', async () => {
    const hanging = (): Response =>
      new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), {
        headers: { 'content-type': 'application/json' },
      });
    let hang = true;
    const near = fakeNear({ chat: (call) => (hang ? hanging() : okChat(call)) });
    const adapter = adapterFor(near);
    const controller = new AbortController();
    const pending = adapter.chat(chatBody(), controller.signal);
    await vi.waitFor(() => expect(near.chats).toHaveLength(1));
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    hang = false;
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(near.reports).toHaveLength(1);
  });

  it('drops the cached key after a failed chat', async () => {
    let fail = true;
    const near = fakeNear({ chat: (call) => (fail ? new Response('{"error":{}}', { status: 400 }) : okChat(call)) });
    const adapter = adapterFor(near);
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    fail = false;
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(near.reports).toHaveLength(2);
  });

  it('returns attestation-failed and sends nothing when the check fails', async () => {
    const near = fakeNear({});
    const verifier = fakeVerifier({ verifyGpu: async () => ({ verdict: false, nonce: '' }) });
    const adapter = adapterFor(near, { verifier });
    expect(await adapter.chat(chatBody(), signal())).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'gpu-verdict' },
    });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'gpu-verdict' });
    expect(near.chats).toHaveLength(0);
  });

  it('never sends to a model without a model attestation', async () => {
    const near = fakeNear({
      report: (model, nonce, keyHex) =>
        model === CLOSED_MODEL
          ? { error: { message: 'Model not found or does not support attestation' } }
          : { model_attestations: [attestation(model, keyHex, nonce)] },
    });
    const adapter = adapterFor(near);
    expect(await adapter.chat(chatBody({ model: CLOSED_MODEL }), signal())).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'no-model-attestation' },
    });
    expect(near.chats).toHaveLength(0);
  });

  it('fails when the verified attestation names another model', async () => {
    const near = fakeNear({ report: (_model, nonce, keyHex) => ({ model_attestations: [attestation(OTHER_MODEL, keyHex, nonce)] }) });
    const adapter = adapterFor(near);
    expect(await adapter.chat(chatBody(), signal())).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'model-name' },
    });
    expect(near.chats).toHaveLength(0);
  });

  it('skips an attestation for another model and pins the next one that passes', async () => {
    const otherKey = newClientKeys();
    const near = fakeNear({
      report: (model, nonce, keyHex) => ({
        model_attestations: [attestation(OTHER_MODEL, otherKey.publicKeyHex, nonce), attestation(model, keyHex, nonce)],
      }),
    });
    expect((await adapterFor(near).chat(chatBody(), signal())).ok).toBe(true);
    expect(near.chats[0].headers['x-model-pub-key']).toBe(near.modelKey.publicKeyHex);
  });

  it('reports a verifier that throws as unreachable without its text', async () => {
    const near = fakeNear({});
    const verifier = fakeVerifier({
      verifyQuote: async () => {
        throw new Error('https://api.trustedservices.intel.com/secret');
      },
    });
    const adapter = adapterFor(near, { verifier });
    expect(await adapter.chat(chatBody(), signal())).toEqual({
      ok: false,
      failure: { kind: 'unreachable', detail: 'attestation service' },
    });
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: false, detail: 'attestation service', unreachable: true });
    expect(near.chats).toHaveLength(0);
  });

  it('reports a rate-limited or failing report endpoint as unreachable, not failed', async () => {
    for (const status of [429, 503]) {
      const near = fakeNear({ report: () => new Response('{"error":"busy"}', { status }) });
      const adapter = adapterFor(near);
      expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'attestation report', unreachable: true });
      expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'attestation report' } });
      expect(near.chats).toHaveLength(0);
    }
  });

  it('reports an aborted check as unreachable', async () => {
    const controller = new AbortController();
    controller.abort();
    const near = fakeNear({});
    expect(await adapterFor(near).verifyAttestation(MODEL, controller.signal)).toEqual({ ok: false, detail: 'aborted', unreachable: true });
  });

  it('logs the TCB status when the check fails on it', async () => {
    const log = vi.fn();
    const verifier = fakeVerifier();
    verifier.verifyQuote.mockImplementation(async (quoteHex: string) => ({
      status: 'Revoked',
      reportData: hexToBytes(quoteHex),
      mrConfigId: MRCONFIG,
      rtmr3: RTMR3,
      debug: false,
    }));
    const adapter = adapterFor(fakeNear({}), { verifier, log });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'tcb-status' });
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'near', model: MODEL, outcome: 'failed:tcb-status', tcbStatus: 'Revoked' });
  });

  it('verifyAttestation(null) checks the first model', async () => {
    const near = fakeNear({});
    expect(await adapterFor(near).verifyAttestation(null, signal())).toEqual({ ok: true });
    expect(near.reports.map((r) => r.model)).toEqual([MODEL]);
  });

  it('returns 400 and sends nothing for content NEAR can’t encrypt', async () => {
    const near = fakeNear({});
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    expect(await adapterFor(near).chat(body, signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    expect(near.chats).toHaveLength(0);
  });

  it('never sends replayed reasoning', async () => {
    const near = fakeNear({});
    const messages = [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi', reasoning_content: 'REASONINGMARKER', reasoning: 'REASONINGMARKER' },
      { role: 'user', content: 'Again' },
    ];
    expect((await adapterFor(near).chat(chatBody({ messages }), signal())).ok).toBe(true);
    expect(JSON.stringify(near.chats[0].body)).not.toContain('REASONINGMARKER');
  });

  it('strips logprobs before sending', async () => {
    const near = fakeNear({});
    await adapterFor(near).chat(chatBody({ logprobs: true, top_logprobs: 5, temperature: 0.2 }), signal());
    expect(near.chats[0].body).not.toHaveProperty('logprobs');
    expect(near.chats[0].body).not.toHaveProperty('top_logprobs');
    expect(near.chats[0].body.temperature).toBe(0.2);
  });

  it('decrypts a streamed reply into plain OpenAI chunks', async () => {
    const near = fakeNear({
      chat: (call) => {
        const to = clientKey(call);
        const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
          JSON.stringify({ id: 's1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
        return sse([
          chunk({ role: 'assistant', content: encryptField('Hel', to) }),
          chunk({ content: encryptField('lo', to), reasoning_content: encryptField('thinking', to) }),
          chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: encryptField('f', to), arguments: encryptField('{}', to) } }] }),
          JSON.stringify({ id: 's1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
          '[DONE]',
        ]);
      },
    });
    const result = await adapterFor(near).chat(chatBody({ stream: true }), signal());
    expect(result.ok).toBe(true);
    if (result.ok === false) return;
    expect(result.response.headers.get('content-type')).toBe('text/event-stream');
    const text = await result.response.text();
    const events = text.split('\n\n').filter(Boolean);
    expect(events.at(-1)).toBe('data: [DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.slice('data: '.length)));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: 'Hel' });
    expect(chunks[1].choices[0].delta).toEqual({ content: 'lo', reasoning_content: 'thinking' });
    expect(chunks[2].choices[0].delta.tool_calls[0].function).toEqual({ name: 'f', arguments: '{}' });
    expect(chunks[3].usage).toEqual({ prompt_tokens: 7, completion_tokens: 2 });
  });

  it('fails the stream when a delta doesn’t decrypt', async () => {
    const near = fakeNear({
      chat: (call) =>
        sse([
          JSON.stringify({ choices: [{ index: 0, delta: { content: encryptField('fine', clientKey(call)) } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'plain text leak' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: { content: encryptField('after', clientKey(call)) } }] }),
          '[DONE]',
        ]),
    });
    const adapter = adapterFor(near);
    const result = await adapter.chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('expected a stream');
    const text = await result.response.text();
    expect(text).not.toContain('plain text leak');
    expect(text).not.toContain('after');
    expect(text.endsWith(ERROR_EVENT)).toBe(true);
    // The failed stream dropped the key.
    await adapter.chat(chatBody(), signal());
    expect(near.reports).toHaveLength(2);
  });

  it('drops the cached key when the stream errors mid-way', async () => {
    let streamed = false;
    const near = fakeNear({
      chat: (call) => {
        if (streamed) return okChat(call);
        streamed = true;
        const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: encryptField('a', clientKey(call)) } }] })}\n\n`;
        let sent = false;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(c): void {
              if (sent) return c.error(new Error('connection reset'));
              sent = true;
              c.enqueue(new TextEncoder().encode(first));
            },
          },
          { highWaterMark: 0 }
        );
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const adapter = adapterFor(near);
    const result = await adapter.chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('expected a stream');
    expect((await result.response.text()).endsWith(ERROR_EVENT)).toBe(true);
    await adapter.chat(chatBody(), signal());
    expect(near.reports).toHaveLength(2);
  });

  it('fails a stream that ends without [DONE] or isn’t SSE, and drops the key', async () => {
    for (const reply of [
      (call: ChatCall): Response => sse([JSON.stringify({ choices: [{ index: 0, delta: { content: encryptField('a', clientKey(call)) } }] })]),
      (): Response => new Response('{"choices":[]}', { headers: { 'content-type': 'application/json' } }),
    ]) {
      const near = fakeNear({ chat: reply });
      const adapter = adapterFor(near);
      const result = await adapter.chat(chatBody({ stream: true }), signal());
      if (result.ok === false) throw new Error('expected a stream');
      expect((await result.response.text()).endsWith(ERROR_EVENT)).toBe(true);
      await adapter.chat(chatBody(), signal());
      expect(near.reports).toHaveLength(2);
    }
  });

  it('fails a non-streamed reply without choices and drops the key', async () => {
    let first = true;
    const near = fakeNear({
      chat: (call) => {
        if (!first) return okChat(call);
        first = false;
        return Response.json({ id: 'c1', object: 'chat.completion' });
      },
    });
    const adapter = adapterFor(near);
    expect(await adapter.chat(chatBody(), signal())).toEqual({
      ok: false,
      failure: { kind: 'mid-stream', detail: 'unreadable reply' },
    });
    await adapter.chat(chatBody(), signal());
    expect(near.reports).toHaveLength(2);
  });

  it('decrypts a non-streamed reply', async () => {
    const near = fakeNear({
      chat: (call) =>
        Response.json({
          id: 'c1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: encryptField('Answer', clientKey(call)),
                reasoning_content: encryptField('why', clientKey(call)),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
    });
    const result = await adapterFor(near).chat(chatBody(), signal());
    if (result.ok === false) throw new Error('expected a reply');
    expect(result.response.headers.get('content-type')).toMatch(/json/);
    expect(await result.response.json()).toEqual({
      id: 'c1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Answer', reasoning_content: 'why' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
  });

  it('fails a non-streamed reply that doesn’t decrypt', async () => {
    const near = fakeNear({
      chat: () => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'plain' } }] }),
    });
    expect(await adapterFor(near).chat(chatBody(), signal())).toEqual({
      ok: false,
      failure: { kind: 'mid-stream', detail: 'undecryptable reply' },
    });
  });

  it('aborts attestation and the upstream body on signal', async () => {
    // Attestation: the quote check waits until the signal aborts.
    const near = fakeNear({});
    const controller = new AbortController();
    let entered!: () => void;
    const quoteStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const verifier = fakeVerifier({
      verifyQuote: (_hex: string, s: AbortSignal) =>
        new Promise((_resolve, reject) => {
          s.addEventListener('abort', () => reject(s.reason), { once: true });
          entered();
        }),
    });
    const pending = adapterFor(near, { verifier }).chat(chatBody(), controller.signal);
    await quoteStarted;
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(near.chats).toHaveLength(0);

    // Stream: the upstream body is cancelled when the signal aborts after the head.
    let cancelled = false;
    const upstream = (call: ChatCall): Response => {
      const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: encryptField('a', clientKey(call)) } }] })}\n\n`;
      let sent = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(c): Promise<void> | void {
            if (sent) return new Promise<void>(() => undefined);
            sent = true;
            c.enqueue(new TextEncoder().encode(first));
          },
          cancel(): void {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const streaming = fakeNear({ chat: upstream });
    const streamController = new AbortController();
    const result = await adapterFor(streaming).chat(chatBody({ stream: true }), streamController.signal);
    if (result.ok === false) throw new Error('expected a stream');
    expect(streaming.chats[0].signal).toBe(streamController.signal);
    const reader = result.response.body!.getReader();
    await reader.read();
    const next = reader.read();
    streamController.abort();
    await expect(next).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});

describe('other methods', () => {
  it('checkKey sends a one-token encrypted chat to the first model', async () => {
    const near = fakeNear({});
    expect(await adapterFor(near).checkKey(signal())).toEqual({ ok: true });
    expect(near.chats[0].body.model).toBe(MODEL);
    expect(near.chats[0].body.max_tokens).toBe(1);
    expect(near.chats[0].headers['x-model-pub-key']).toBe(near.modelKey.publicKeyHex);
  });

  it('checkKey reports a bad key', async () => {
    const near = fakeNear({ chat: () => new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }) });
    expect(await adapterFor(near).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'bad-key' } });
  });

  it('checkKey accepts a key whose account has no credit', async () => {
    const near = fakeNear({ chat: () => new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 }) });
    expect(await adapterFor(near).checkKey(signal())).toEqual({ ok: true });
  });

  it('checkKey reports a failed hardware check as such, not as a bad key or unreachable', async () => {
    const near = fakeNear({});
    const verifier = fakeVerifier({ verifyGpu: async () => ({ verdict: false, nonce: '' }) });
    expect(await adapterFor(near, { verifier }).checkKey(signal())).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'gpu-verdict' },
    });
    expect(near.chats).toHaveLength(0);
  });

  it('testToolCall reports a decrypted tool call', async () => {
    const near = fakeNear({
      chat: (call) => {
        const tool = (call.body.tools as { function: { name: string } }[])[0];
        const name = decryptField(tool.function.name, near.modelKey);
        return Response.json({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: encryptField(name, clientKey(call)), arguments: encryptField('{}', clientKey(call)) } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
      },
    });
    expect(await adapterFor(near).testToolCall(signal())).toBe(true);
  });

  it('testToolCall is false when none comes back', async () => {
    const near = fakeNear({});
    expect(await adapterFor(near).testToolCall(signal())).toBe(false);
  });

  it('readBalance returns null', async () => {
    expect(await adapterFor(fakeNear({})).readBalance(signal())).toBeNull();
  });

  it('never logs the key', async () => {
    const log = vi.fn();
    const near = fakeNear({
      models: { data: [{ id: MODEL, pricing: { prompt: '0.000001', completion: '0.000001' } }] },
    });
    const adapter = adapterFor(near, { log });
    await adapter.checkKey(signal());
    await adapter.verifyAttestation(null, signal());
    await adapter.listModels(signal());
    await adapter.readBalance(signal());
    await adapter.testToolCall(signal());
    const result = await adapter.chat(chatBody(), signal());
    if (result.ok === true) await result.response.text();
    const failing = adapterFor(fakeNear({ chat: () => new Response('sk-SECRETMARKER', { status: 500 }) }), { log });
    await failing.chat(chatBody(), signal());

    expect(log).toHaveBeenCalled();
    for (const args of log.mock.calls) {
      expect(JSON.stringify(args)).not.toContain('SECRETMARKER');
    }
    expect(log).toHaveBeenCalledWith('confidential attestation', {
      provider: 'near',
      model: MODEL,
      outcome: 'verified',
      tcbStatus: 'UpToDate',
    });
  });
});
