import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_kem768_x25519 as XWing } from '@noble/post-quantum/hybrid.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPremAdapter, mapPremError } from '../premAdapter';
import type { attestPrem, ReticleLike } from '../premAttestation';

/**
 * The adapter against a fake Prem. The fake enclave holds an X-Wing key pair: it decapsulates
 * each request's `cipherText`, opens the request with the shared secret and the request nonce,
 * and seals its reply the same way. Attestation is a fake `attestPrem`; Reticle never loads.
 */

const GATEWAY = 'https://gateway.prem.io';
const PUBLIC_KEY_URL = 'https://conf-engine.prem.io/publicKey';
const MODELS_URL = `${GATEWAY}/rvenc/models?type=CHAT`;
const CHAT_URL = `${GATEWAY}/rvenc/chat/completions`;
const TRUSTBASE_PROBE = 'https://trustbase.prem.io/provenance.sigstore.json';
const GATEWAY_PROBE = `${GATEWAY}/`;
const MODEL = 'qwen38-27b';
const OTHER_MODEL = 'gemma4-31b';
const API_KEY = 'sk-SECRETMARKER';
const SESSION = 'sess-1';
const ERROR_EVENT = 'data: {"error":{"message":"The provider’s reply couldn’t be read."}}\n\n';
const utf8 = new TextDecoder();

interface ChatCall {
  headers: Record<string, string>;
  /** The wire body. */
  body: Record<string, unknown>;
  /** The request the enclave opened. */
  request: Record<string, unknown>;
  sharedSecret: Uint8Array;
  nonce: Uint8Array;
  signal: AbortSignal | undefined;
}

type ChatHandler = (call: ChatCall) => Response | Promise<Response>;

function seal(call: { sharedSecret: Uint8Array }, nonce: Uint8Array, value: unknown): string {
  return bytesToHex(xchacha20poly1305(call.sharedSecret, nonce).encrypt(utf8ToBytes(JSON.stringify(value))));
}

function okChat(call: ChatCall): Response {
  const reply = {
    id: 'c1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  };
  return Response.json({ encryptedResponse: seal(call, call.nonce, reply), nonce: bytesToHex(call.nonce), usage: { prompt_tokens: 5, completion_tokens: 1 } });
}

/** A fake Prem gateway and key service. Every request is recorded in `order`. */
function fakePrem(
  opts: {
    chat?: ChatHandler;
    models?: unknown;
    modelsResponse?: () => Response;
    publicKey?: () => Response;
    /** Answers the reachability probes after a verifier failure; 200 by default. */
    probe?: (url: string) => Response;
  } = {}
) {
  const enclave = XWing.keygen();
  const order: string[] = [];
  const chats: ChatCall[] = [];
  const probes: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    order.push(url === CHAT_URL ? 'chat' : url === PUBLIC_KEY_URL ? 'publicKey' : url === MODELS_URL ? 'models' : url);
    if (url === TRUSTBASE_PROBE || url === GATEWAY_PROBE) {
      probes.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return opts.probe ? opts.probe(url) : new Response(null, { status: 200 });
    }
    if (url === PUBLIC_KEY_URL) {
      return opts.publicKey ? opts.publicKey() : Response.json({ publicKey: bytesToHex(enclave.publicKey) });
    }
    if (url === MODELS_URL) {
      if (opts.modelsResponse) return opts.modelsResponse();
      return Response.json(opts.models ?? { data: [] });
    }
    if (url === CHAT_URL && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as Record<string, string>;
      const sharedSecret = XWing.decapsulate(hexToBytes(body.cipherText), enclave.secretKey);
      const nonce = hexToBytes(body.nonce);
      const request = JSON.parse(utf8.decode(xchacha20poly1305(sharedSecret, nonce).decrypt(hexToBytes(body.encryptedInference))));
      const call: ChatCall = {
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body,
        request,
        sharedSecret,
        nonce,
        signal: init.signal ?? undefined,
      };
      chats.push(call);
      return (opts.chat ?? okChat)(call);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { fetch: fetchImpl as unknown as typeof fetch, enclave, order, chats, probes };
}

type AttestFn = typeof attestPrem;

function fakeAttest(order?: string[]): ReturnType<typeof vi.fn<AttestFn>> {
  return vi.fn<AttestFn>(async ({ model }) => {
    order?.push('attest');
    return { ok: true, value: { sessionId: SESSION, workloadId: `${model}-h100-pcie-1-96g` } };
  });
}

const fakeReticle = async (): Promise<ReticleLike> => ({}) as ReticleLike;

function adapterFor(prem: ReturnType<typeof fakePrem>, extra: Partial<Parameters<typeof createPremAdapter>[0]> = {}) {
  return createPremAdapter({
    apiKey: API_KEY,
    models: [MODEL, OTHER_MODEL],
    fetch: prem.fetch,
    attest: fakeAttest(prem.order),
    reticle: fakeReticle,
    ...extra,
  });
}

/** An SSE body from raw event blocks, each ending in a blank line. */
function sse(blocks: string[]): Response {
  return new Response(blocks.map((b) => `${b}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function chunk(content: string): Record<string, unknown> {
  return { id: 's1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

const signal = (): AbortSignal => new AbortController().signal;
const chatBody = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello there' }], ...extra });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listModels', () => {
  it('lists models with per-million prices', async () => {
    const prem = fakePrem({
      models: {
        data: [
          {
            id: MODEL,
            input_modalities: ['text'],
            price_config: {
              standard: { default: { prompt_price_per_k: 0.00001, completion_price_per_k: 0.00002 } },
              confidential: {
                'us-east': { prompt_price_per_k: 0.9, completion_price_per_k: 0.9 },
                default: { prompt_price_per_k: 0.0001, cached_prompt_price_per_k: 0.00005, completion_price_per_k: 0.0004 },
              },
            },
          },
          // No `default`: the first region is read.
          { id: OTHER_MODEL, price_config: { confidential: { 'eu-west': { prompt_price_per_k: '0.0002', completion_price_per_k: '0.0008' } } } },
          { id: 'a/no-price' },
          { id: 'a/no-output', price_config: { confidential: { default: { prompt_price_per_k: 0.001 } } } },
          { id: 'a/unknown', price_config: { confidential: { default: { prompt_price_per_k: 0.001, completion_price_per_k: 0.001 } } } },
        ],
      },
    });
    const adapter = adapterFor(prem, { models: [MODEL, OTHER_MODEL, 'a/no-price', 'a/no-output'] });
    expect(await adapter.listModels(signal())).toEqual([
      { providerModelId: MODEL, contextLength: null, precision: null, price: { inputPerM: 0.1, cachedInputPerM: 0.05, outputPerM: 0.4 } },
      { providerModelId: OTHER_MODEL, contextLength: null, precision: null, price: { inputPerM: 0.2, cachedInputPerM: null, outputPerM: 0.8 } },
      { providerModelId: 'a/no-price', contextLength: null, precision: null, price: null },
      { providerModelId: 'a/no-output', contextLength: null, precision: null, price: null },
    ]);
  });

  it('never prices a model from the standard tier', async () => {
    const prem = fakePrem({
      models: { data: [{ id: MODEL, price_config: { standard: { default: { prompt_price_per_k: 0.0001, completion_price_per_k: 0.0004 } } } }] },
    });
    expect(await adapterFor(prem).listModels(signal())).toEqual([{ providerModelId: MODEL, contextLength: null, precision: null, price: null }]);
  });

  it('lists a model under its model field, else its id', async () => {
    const rates = { confidential: { default: { prompt_price_per_k: 0.001, completion_price_per_k: 0.002 } } };
    const prem = fakePrem({
      models: [
        { id: 'prem-internal-1', model: MODEL, price_config: rates },
        { id: OTHER_MODEL, model: '', price_config: rates },
        // Matched by neither field once `model` is set.
        { id: 'a/listed-by-id', model: 'a/other', price_config: rates },
      ],
    });
    const adapter = adapterFor(prem, { models: [MODEL, OTHER_MODEL, 'a/listed-by-id', 'prem-internal-1'] });
    expect((await adapter.listModels(signal())).map((offer) => offer.providerModelId)).toEqual([MODEL, OTHER_MODEL]);
  });

  it('sends the key and throws a fixed message when the list can’t be read', async () => {
    const prem = fakePrem({ modelsResponse: () => new Response('sk-SECRETMARKER', { status: 500 }) });
    await expect(adapterFor(prem).listModels(signal())).rejects.toThrow('Prem’s model list couldn’t be read.');
    const thrown = vi.fn(async () => {
      throw new Error(`${MODELS_URL} sk-SECRETMARKER`);
    }) as unknown as typeof fetch;
    await expect(adapterFor(prem, { fetch: thrown }).listModels(signal())).rejects.toThrow('Prem’s model list couldn’t be reached.');
  });
});

describe('mapPremError', () => {
  it('maps errors', async () => {
    const none = new Headers();
    expect(mapPremError(401, '', none)).toEqual({ kind: 'bad-key' });
    expect(mapPremError(429, '', new Headers({ 'Retry-After': '12' }))).toEqual({ kind: 'rate-limited', retryAfterMs: 12000 });
    expect(mapPremError(429, '', none)).toEqual({ kind: 'rate-limited' });
    expect(mapPremError(400, '{"error":{"code":"INSUFFICIENT_FUNDS","message":"…"}}', none)).toEqual({ kind: 'no-balance' });
    expect(mapPremError(400, '{"error":"bad request"}', none)).toEqual({ kind: 'server', status: 400 });
    expect(mapPremError(502, '', none)).toEqual({ kind: 'server', status: 502 });

    const thrown = fakePrem({
      chat: () => {
        throw new Error('connect ECONNREFUSED https://gateway.prem.io sk-SECRETMARKER');
      },
    });
    expect(await adapterFor(thrown).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'chat' } });
  });

  it('maps a 400 with INSUFFICIENT_FUNDS on chat and bounds the error body it reads', async () => {
    const funds = fakePrem({ chat: () => new Response('{"error":{"code":"INSUFFICIENT_FUNDS"}}', { status: 400 }) });
    expect(await adapterFor(funds).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'no-balance' } });

    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const prem = fakePrem({ chat: () => new Response(big, { status: 400 }) });
    expect(await adapterFor(prem).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    expect(pulled).toBeLessThan(10);
  });
});

describe('chat', () => {
  it('attests, fetches the enclave key, then sends with the session id', async () => {
    const prem = fakePrem();
    const attest = fakeAttest(prem.order);
    const result = await adapterFor(prem, { attest }).chat(chatBody({ temperature: 0.2 }), signal());
    expect(result.ok).toBe(true);
    expect(prem.order).toEqual(['attest', 'publicKey', 'chat']);
    expect(attest).toHaveBeenCalledWith(expect.objectContaining({ apiKey: API_KEY, model: MODEL }));

    const call = prem.chats[0];
    expect(call.headers['x-session-id']).toBe(SESSION);
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(Object.keys(call.body).sort()).toEqual(['cipherText', 'encryptedInference', 'model', 'nonce', 'stream']);
    expect(call.body.model).toBe(MODEL);
    expect(call.body.stream).toBe(false);
    expect(JSON.stringify(call.body)).not.toContain('Hello');
    expect(call.request).toEqual({ model: MODEL, messages: [{ role: 'user', content: 'Hello there' }], temperature: 0.2 });
    if (result.ok === true) {
      expect(await result.response.json()).toEqual({
        id: 'c1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });
    }
  });

  it('uses a fresh nonce and encapsulation for each request', async () => {
    const prem = fakePrem();
    const adapter = adapterFor(prem);
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody(), signal());
    expect(prem.chats[0].body.nonce).not.toBe(prem.chats[1].body.nonce);
    expect(prem.chats[0].body.cipherText).not.toBe(prem.chats[1].body.cipherText);
  });

  it('returns attestation-failed and sends nothing when the check fails', async () => {
    const prem = fakePrem();
    const attest = vi.fn<AttestFn>(async () => ({ ok: false, detail: 'workload' }));
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'workload' } });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'workload' });
    expect(prem.order).toEqual([]);
  });

  it('reports a verifier failure as failed and an aborted check as unreachable', async () => {
    const prem = fakePrem();
    const attest = vi.fn<AttestFn>(async () => ({ ok: false, detail: 'verifier' }));
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'verifier' });
    const controller = new AbortController();
    controller.abort();
    expect(await adapter.verifyAttestation(MODEL, controller.signal)).toEqual({ ok: false, detail: 'aborted', unreachable: true });
    expect(prem.chats).toHaveLength(0);
  });

  it('reads a verifier failure as failed when Prem’s hosts answer, without sending the key', async () => {
    const prem = fakePrem({ probe: () => new Response('not here', { status: 404 }) });
    const attest = vi.fn<AttestFn>(async () => ({ ok: false, detail: 'verifier' }));
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'verifier' });
    expect(prem.probes.map((p) => p.url).sort()).toEqual([GATEWAY_PROBE, TRUSTBASE_PROBE]);
    for (const probe of prem.probes) {
      expect(probe.method).toBe('HEAD');
      expect(probe.headers.authorization).toBeUndefined();
    }
    expect(JSON.stringify(prem.probes)).not.toContain('SECRETMARKER');
  });

  it.each([
    ['trustbase throws', (url: string): Response => {
      if (url === TRUSTBASE_PROBE) throw new TypeError('fetch failed');
      return new Response(null, { status: 200 });
    }],
    ['the gateway answers 503', (url: string): Response => new Response(null, { status: url === GATEWAY_PROBE ? 503 : 200 })],
    ['trustbase answers 429', (url: string): Response => new Response(null, { status: url === TRUSTBASE_PROBE ? 429 : 200 })],
  ])('reads a verifier failure as unreachable when %s', async (_name, probe) => {
    const prem = fakePrem({ probe });
    const attest = vi.fn<AttestFn>(async () => ({ ok: false, detail: 'verifier' }));
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'verifier host', unreachable: true });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'verifier host' } });
    expect(prem.chats).toHaveLength(0);
  });

  it('probes only after a verifier failure', async () => {
    const prem = fakePrem();
    const attest = vi.fn<AttestFn>(async () => ({ ok: false, detail: 'workload' }));
    await adapterFor(prem, { attest }).verifyAttestation(MODEL, signal());
    expect(prem.probes).toEqual([]);
  });

  it('fails the attestation when the enclave key isn’t an X-Wing key', async () => {
    const prem = fakePrem({ publicKey: () => Response.json({ publicKey: 'abcd' }) });
    expect(await adapterFor(prem).chat(chatBody(), signal())).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'enclave-key' },
    });
    expect(prem.chats).toHaveLength(0);
  });

  it('reports an unreachable key service with a fixed detail', async () => {
    const prem = fakePrem({ publicKey: () => new Response('https://conf-engine.prem.io down', { status: 503 }) });
    expect(await adapterFor(prem).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'enclave key' } });
    expect(prem.chats).toHaveLength(0);
  });

  it('reports a verifier that won’t load as unreachable and sends nothing', async () => {
    const prem = fakePrem();
    const attest = fakeAttest();
    const reticle = async (): Promise<ReticleLike> => {
      throw new Error('/Users/someone/node_modules/@premai/reticle/reticle_bg.wasm missing');
    };
    const adapter = adapterFor(prem, { attest, reticle });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'verifier unavailable' } });
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: false, detail: 'verifier unavailable', unreachable: true });
    expect(attest).not.toHaveBeenCalled();
    expect(prem.order).toEqual([]);
  });

  it('verifyAttestation(null) checks the first model and its session serves the next chat', async () => {
    const prem = fakePrem();
    const attest = fakeAttest(prem.order);
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: true });
    expect(attest.mock.calls[0][0].model).toBe(MODEL);
    await adapter.chat(chatBody(), signal());
    expect(prem.order).toEqual(['attest', 'publicKey', 'chat']);
  });

  it('reuses the session for 30 minutes, then attests again', async () => {
    const prem = fakePrem();
    const attest = fakeAttest();
    const adapter = adapterFor(prem, { attest });
    await adapter.chat(chatBody(), signal());
    vi.advanceTimersByTime(29 * 60 * 1000);
    await adapter.chat(chatBody(), signal());
    expect(attest).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 1000);
    await adapter.chat(chatBody(), signal());
    expect(attest).toHaveBeenCalledTimes(2);
    expect(prem.chats).toHaveLength(3);
  });

  it('keeps sessions per model', async () => {
    const prem = fakePrem();
    const attest = fakeAttest();
    const adapter = adapterFor(prem, { attest });
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody({ model: OTHER_MODEL }), signal());
    expect(attest.mock.calls.map((c) => c[0].model)).toEqual([MODEL, OTHER_MODEL]);
  });

  it('drops it after a failed chat', async () => {
    let fail = true;
    const prem = fakePrem({ chat: (call) => (fail ? new Response('{"error":{}}', { status: 502 }) : okChat(call)) });
    const attest = fakeAttest();
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 502 } });
    fail = false;
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(attest).toHaveBeenCalledTimes(2);
  });

  it('keeps the session after a chat aborted while its reply is read, as an aborted stream does', async () => {
    // A non-streamed reply whose body never ends, so the abort lands while it is read.
    const hanging = (): Response =>
      new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), {
        headers: { 'content-type': 'application/json' },
      });
    let hang = true;
    const prem = fakePrem({ chat: (call) => (hang ? hanging() : okChat(call)) });
    const attest = fakeAttest();
    const adapter = adapterFor(prem, { attest });
    const controller = new AbortController();
    const pending = adapter.chat(chatBody(), controller.signal);
    await vi.waitFor(() => expect(prem.chats).toHaveLength(1));
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    hang = false;
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(attest).toHaveBeenCalledTimes(1);
  });

  it('returns at once when the caller aborts while Reticle is still loading', async () => {
    const prem = fakePrem();
    const attest = fakeAttest();
    const controller = new AbortController();
    const reticle = (): Promise<ReticleLike> => new Promise<ReticleLike>(() => undefined);
    const pending = adapterFor(prem, { attest, reticle }).chat(chatBody(), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(attest).not.toHaveBeenCalled();
    expect(prem.order).toEqual([]);
    // Already aborted when the check begins.
    expect(await adapterFor(prem, { attest, reticle }).chat(chatBody(), controller.signal)).toEqual({
      ok: false,
      failure: { kind: 'unreachable', detail: 'aborted' },
    });
  });

  it('returns 400 and sends nothing for content that isn’t text, joining text parts', async () => {
    const prem = fakePrem();
    const attest = fakeAttest();
    const adapter = adapterFor(prem, { attest });
    const image = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    expect(await adapter.chat(image, signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    expect(attest).not.toHaveBeenCalled();
    expect(prem.order).toEqual([]);

    const parts = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }],
    });
    expect((await adapter.chat(parts, signal())).ok).toBe(true);
    expect(prem.chats[0].request.messages).toEqual([{ role: 'user', content: 'one\n\ntwo' }]);
  });

  it('applies NEAR’s message rules: only allowlisted message fields sent', async () => {
    const prem = fakePrem();
    const adapter = adapterFor(prem);
    const messages = [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi', reasoning_content: 'why', reasoning_details: [{ text: 'why' }], tool_calls: [] as unknown[] },
    ];
    expect((await adapter.chat(chatBody({ messages }), signal())).ok).toBe(true);
    expect(prem.chats[0].request.messages).toEqual([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi', tool_calls: [] },
    ]);

    const extra = chatBody({ messages: [{ role: 'user', content: 'Hi', metadata: { note: 'x' } }] });
    expect((await adapter.chat(extra, signal())).ok).toBe(true);
    expect(prem.chats[1].request.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('opens a non-streamed reply under the nonce the reply names', async () => {
    const replyNonce = new Uint8Array(24).fill(9);
    const prem = fakePrem({
      chat: (call) =>
        Response.json({
          encryptedResponse: seal(call, replyNonce, { choices: [{ index: 0, message: { role: 'assistant', content: 'own nonce' } }] }),
          nonce: bytesToHex(replyNonce),
        }),
    });
    const result = await adapterFor(prem).chat(chatBody(), signal());
    if (result.ok === false) throw new Error(result.failure.kind);
    expect(await result.response.json()).toMatchObject({ choices: [{ message: { content: 'own nonce' } }] });
  });

  it('strips logprobs before sealing', async () => {
    const prem = fakePrem();
    await adapterFor(prem).chat(chatBody({ logprobs: true, top_logprobs: 5 }), signal());
    expect(prem.chats[0].request).not.toHaveProperty('logprobs');
    expect(prem.chats[0].request).not.toHaveProperty('top_logprobs');
  });

  it('fails a non-streamed reply that doesn’t decrypt and drops the session', async () => {
    let first = true;
    const prem = fakePrem({
      chat: (call) => {
        if (!first) return okChat(call);
        first = false;
        return Response.json({ encryptedResponse: seal({ sharedSecret: randomBytes(32) }, call.nonce, { choices: [] }), usage: {} });
      },
    });
    const attest = fakeAttest();
    const adapter = adapterFor(prem, { attest });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'undecryptable reply' } });
    await adapter.chat(chatBody(), signal());
    expect(attest).toHaveBeenCalledTimes(2);
  });

  it('fails a plain reply rather than passing it on', async () => {
    const prem = fakePrem({ chat: () => Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'plain' } }] }) });
    expect(await adapterFor(prem).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'unreadable reply' } });
  });

  it('decrypts a stream, drops heartbeats and ends on done', async () => {
    const prem = fakePrem({
      chat: (call) => {
        const ownNonce = randomBytes(24);
        return sse([
          `event: data\ndata: ${seal(call, call.nonce, chunk('Hel'))}`,
          'event: heartbeat\ndata: {}',
          `data: ${JSON.stringify({ nonce: bytesToHex(ownNonce), data: seal(call, ownNonce, chunk('lo')) })}`,
          'event: inferenceOutcome\ndata: {"status":"succeeded"}',
          'event: done\ndata: {}',
        ]);
      },
    });
    const result = await adapterFor(prem).chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('expected a stream');
    expect(prem.chats[0].body.stream).toBe(true);
    expect(result.response.headers.get('content-type')).toBe('text/event-stream');
    const events = (await result.response.text()).split('\n\n').filter(Boolean);
    expect(events).toEqual([`data: ${JSON.stringify(chunk('Hel'))}`, `data: ${JSON.stringify(chunk('lo'))}`, 'data: [DONE]']);
  });

  it('logs an event name it doesn’t know, once per name, and drops the event', async () => {
    const log = vi.fn<(message: string, data: Record<string, unknown>) => void>();
    const prem = fakePrem({
      chat: (call) =>
        sse([
          'event: heartbeat\ndata: {}',
          'event: usageReport\ndata: {"secret":"x"}',
          'event: usageReport\ndata: {}',
          'event: <odd name>\ndata: {}',
          `event: data\ndata: ${seal(call, call.nonce, chunk('a'))}`,
          'event: done',
        ]),
    });
    const result = await adapterFor(prem, { log }).chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('expected a stream');
    expect((await result.response.text()).split('\n\n').filter(Boolean)).toEqual([`data: ${JSON.stringify(chunk('a'))}`, 'data: [DONE]']);
    const dropped = log.mock.calls.filter(([message]) => message === 'confidential stream event dropped').map(([, data]) => data);
    expect(dropped).toEqual([
      { provider: 'prem', event: 'usageReport' },
      { provider: 'prem', event: 'other' },
    ]);
  });

  it('ends on a done event without data', async () => {
    const prem = fakePrem({ chat: (call) => sse([`event: data\ndata: ${seal(call, call.nonce, chunk('a'))}`, 'event: done']) });
    const result = await adapterFor(prem).chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('expected a stream');
    expect((await result.response.text()).endsWith('data: [DONE]\n\n')).toBe(true);
  });

  describe('fails the stream', () => {
    const cases: [string, (call: ChatCall) => string[]][] = [
      ['on an undecryptable frame', (call) => [`event: data\ndata: ${seal({ sharedSecret: randomBytes(32) }, call.nonce, chunk('leak'))}`]],
      ['on a plain frame', () => [`event: data\ndata: ${JSON.stringify(chunk('leak'))}`]],
      ['on a frame that isn’t a JSON object', (call) => [`event: data\ndata: ${seal(call, call.nonce, ['leak'])}`]],
      ['on an error event', () => ['event: error\ndata: {"message":"leak"}']],
      ['on an inferenceOutcome with status failed', () => ['event: inferenceOutcome\ndata: {"status":"failed"}']],
    ];
    for (const [name, blocks] of cases) {
      it(name, async () => {
        let first = true;
        const prem = fakePrem({
          chat: (call) => {
            if (!first) return okChat(call);
            first = false;
            return sse([`event: data\ndata: ${seal(call, call.nonce, chunk('fine'))}`, ...blocks(call), `event: data\ndata: ${seal(call, call.nonce, chunk('after'))}`, 'event: done']);
          },
        });
        const attest = fakeAttest();
        const adapter = adapterFor(prem, { attest });
        const result = await adapter.chat(chatBody({ stream: true }), signal());
        if (result.ok === false) throw new Error('expected a stream');
        const text = await result.response.text();
        expect(text.startsWith(`data: ${JSON.stringify(chunk('fine'))}\n\n`)).toBe(true);
        expect(text).not.toContain('leak');
        expect(text).not.toContain('after');
        expect(text.endsWith(ERROR_EVENT)).toBe(true);
        // The failed stream dropped the session.
        await adapter.chat(chatBody(), signal());
        expect(attest).toHaveBeenCalledTimes(2);
      });
    }

    it('when it ends without done', async () => {
      const prem = fakePrem({ chat: (call) => sse([`event: data\ndata: ${seal(call, call.nonce, chunk('a'))}`]) });
      const result = await adapterFor(prem).chat(chatBody({ stream: true }), signal());
      if (result.ok === false) throw new Error('expected a stream');
      expect((await result.response.text()).endsWith(ERROR_EVENT)).toBe(true);
    });
  });

  it('aborts attestation and the upstream body on signal', async () => {
    // Attestation: attestPrem reports an abort as `verifier`; the adapter reads the signal.
    const prem = fakePrem();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const attest = vi.fn<AttestFn>(
      ({ signal: s }) =>
        new Promise((resolve) => {
          s.addEventListener('abort', () => resolve({ ok: false, detail: 'verifier' }), { once: true });
          entered();
        })
    );
    const pending = adapterFor(prem, { attest }).chat(chatBody(), controller.signal);
    await started;
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(prem.order).toEqual([]);

    // Stream: the upstream body is cancelled when the signal aborts after the head.
    let cancelled = false;
    const streaming = fakePrem({
      chat: (call) => {
        const first = `event: data\ndata: ${seal(call, call.nonce, chunk('a'))}\n\n`;
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
      },
    });
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
  it('checkKey reads the model list with the key', async () => {
    const prem = fakePrem();
    const calls: RequestInit[] = [];
    const recording = (async (input: string, init?: RequestInit) => {
      calls.push(init ?? {});
      return prem.fetch(input, init);
    }) as unknown as typeof fetch;
    expect(await adapterFor(prem, { fetch: recording }).checkKey(signal())).toEqual({ ok: true });
    expect(prem.order).toEqual(['models']);
    expect(new Headers(calls[0].headers).get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('checkKey reports a bad key and an unreachable gateway', async () => {
    const prem = fakePrem({ modelsResponse: () => new Response('{"error":"Invalid API key"}', { status: 401 }) });
    expect(await adapterFor(prem).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'bad-key' } });
    const thrown = vi.fn(async () => {
      throw new Error('getaddrinfo gateway.prem.io');
    }) as unknown as typeof fetch;
    expect(await adapterFor(prem, { fetch: thrown }).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'models' } });
  });

  it('testToolCall seals one tool and reports a decrypted tool call', async () => {
    const prem = fakePrem({
      chat: (call) => {
        const tool = (call.request.tools as { function: { name: string } }[])[0];
        const reply = {
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: null as string | null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: tool.function.name, arguments: '{}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        };
        return Response.json({ encryptedResponse: seal(call, call.nonce, reply), nonce: bytesToHex(call.nonce) });
      },
    });
    expect(await adapterFor(prem).testToolCall(signal())).toBe(true);
    expect(prem.chats[0].request.tool_choice).toBe('auto');
    expect(prem.chats[0].request.tools).toHaveLength(1);
    expect(JSON.stringify(prem.chats[0].body)).not.toContain('get_current_time');
  });

  it('testToolCall is false when none comes back', async () => {
    expect(await adapterFor(fakePrem()).testToolCall(signal())).toBe(false);
  });

  it('readBalance returns null', async () => {
    expect(await adapterFor(fakePrem()).readBalance(signal())).toBeNull();
  });

  it('never logs the key', async () => {
    const log = vi.fn();
    const prem = fakePrem({ models: { data: [{ id: MODEL, price_config: { confidential: { default: { prompt_price_per_k: 0.001, completion_price_per_k: 0.001 } } } }] } });
    const adapter = adapterFor(prem, { log });
    await adapter.checkKey(signal());
    await adapter.verifyAttestation(null, signal());
    await adapter.listModels(signal());
    await adapter.readBalance(signal());
    await adapter.testToolCall(signal());
    const result = await adapter.chat(chatBody(), signal());
    if (result.ok === true) await result.response.text();
    const failing = adapterFor(fakePrem({ chat: () => new Response('sk-SECRETMARKER', { status: 500 }) }), { log });
    await failing.chat(chatBody(), signal());
    const refused = adapterFor(prem, { log, attest: vi.fn<AttestFn>(async () => ({ ok: false, detail: 'no-gpu' })) });
    await refused.verifyAttestation(null, signal());

    expect(log).toHaveBeenCalled();
    for (const args of log.mock.calls) {
      const text = JSON.stringify(args);
      expect(text).not.toContain('SECRETMARKER');
      expect(text).not.toContain(bytesToHex(prem.enclave.publicKey).slice(0, 64));
      expect(text).not.toContain(SESSION);
    }
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'prem', model: MODEL, outcome: 'verified', tcbStatus: null });
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'prem', model: MODEL, outcome: 'failed:no-gpu', tcbStatus: null });
  });
});
