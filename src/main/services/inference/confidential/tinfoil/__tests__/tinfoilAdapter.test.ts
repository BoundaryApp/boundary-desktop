import { readFileSync } from 'node:fs';
import path from 'node:path';
import { UsageError, VerificationError } from '@tinfoilsh/verifier';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinMismatchError, type PinnedFetch } from '../pinnedFetch';
import { createTinfoilAdapter, mapTinfoilError } from '../tinfoilAdapter';
import type { TinfoilVerifierLike } from '../tinfoilAttestation';

/**
 * The adapter against a fake Tinfoil. The verifier is a stand-in (the real one runs on the
 * recorded document in tinfoilVerifier.test.ts); the pinned fetch is a stand-in that records the
 * fingerprint each chat was pinned to (the real one is tested in pinnedFetch.test.ts).
 */

const BASE = 'https://inference.tinfoil.sh';
const MODEL = 'deepseek-v4-1-flash';
const OTHER_MODEL = 'glm-5-3';
const API_KEY = 'tk-SECRETMARKER';
const FP = 'aa'.repeat(32);
const FP2 = 'bb'.repeat(32);
const REPO = 'tinfoilsh/confidential-model-router';
const ERROR_EVENT = 'data: {"error":{"message":"The provider’s reply couldn’t be read."}}\n\n';
const models = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'models.json'), 'utf8')) as unknown;

interface ChatCall {
  fingerprint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}
type ChatHandler = (call: ChatCall) => Response | Promise<Response>;

function okChat(): Response {
  return Response.json({
    id: 'c1',
    object: 'chat.completion',
    model: MODEL,
    extra: 'dropped',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok', audio: { data: 'x' } }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  });
}

function sse(events: string[]): Response {
  return new Response(events.map((e) => `data: ${e}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

type Verified = Awaited<ReturnType<TinfoilVerifierLike['verifyV3']>>;

function fakeTinfoil(opts: { chat?: ChatHandler; attestation?: (nonce: string) => Response | Promise<Response>; verified?: () => Verified | Promise<Verified> } = {}) {
  const chats: ChatCall[] = [];
  const attestations: { nonce: string; headers: Record<string, string> }[] = [];
  let verified: () => Verified | Promise<Verified> = opts.verified ?? ((): Verified => ({ tlsPublicKeyFP: FP, codeTag: 'v0.0.176', freshnessExpiresAt: new Date('2026-11-19T00:00:00Z') }));
  const verifyV3 = vi.fn(async (doc: Uint8Array, nonce: Uint8Array, repo: string): Promise<Verified> => {
    expect(repo).toBe(REPO);
    // The fake document is the nonce the adapter sent, so a document for another nonce fails.
    const sent = new TextDecoder().decode(doc);
    if (sent !== Buffer.from(nonce).toString('hex')) throw new VerificationError('nonce mismatch', { layer: 'envelope' });
    return verified();
  });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    if (url.origin + url.pathname === `${BASE}/.well-known/tinfoil-attestation`) {
      const nonce = url.searchParams.get('nonce')!;
      attestations.push({ nonce, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return opts.attestation ? opts.attestation(nonce) : new Response(nonce);
    }
    if (url.href === `${BASE}/v1/models`) return Response.json(models);
    throw new Error(`unexpected fetch ${url.href}`);
  });
  const closed: string[] = [];
  const pinned = vi.fn((fingerprint: string): PinnedFetch => {
    const fetchPinned = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      init?.signal?.throwIfAborted();
      expect(String(input)).toBe(`${BASE}/v1/chat/completions`);
      const call = {
        fingerprint,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(init?.body as string) as Record<string, unknown>,
        signal: init?.signal ?? undefined,
      };
      chats.push(call);
      return (opts.chat ?? okChat)(call);
    }) as typeof fetch;
    return { fetch: fetchPinned, close: () => closed.push(fingerprint) };
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    fetchMock: fetchImpl,
    pinned,
    verifyV3,
    verifier: { verifyV3 } as TinfoilVerifierLike,
    chats,
    attestations,
    /** The fingerprints whose pinned fetch was closed, in order. */
    closed,
    setVerified(next: () => Verified): void {
      verified = next;
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;
const chatBody = (extra: Record<string, unknown> = {}): string => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello there' }], ...extra });

function adapterFor(t: ReturnType<typeof fakeTinfoil>, extra: Partial<Parameters<typeof createTinfoilAdapter>[0]> = {}) {
  return createTinfoilAdapter({
    apiKey: API_KEY,
    models: [MODEL, OTHER_MODEL],
    fetch: t.fetch,
    pinnedFetch: t.pinned,
    verifier: async () => t.verifier,
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('listModels', () => {
  it('lists the catalog’s models from the keyless list with per-million prices and context', async () => {
    const t = fakeTinfoil();
    const listed = await adapterFor(t).listModels(signal());
    expect(listed).toEqual([
      { providerModelId: MODEL, contextLength: 1048576, precision: null, price: { inputPerM: 0.6, cachedInputPerM: 0.01, outputPerM: 1.45 } },
      { providerModelId: OTHER_MODEL, contextLength: 1048576, precision: null, price: { inputPerM: 1.8, cachedInputPerM: 0.45, outputPerM: 5.75 } },
    ]);
    const [, init] = t.fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
  });

  it('throws a fixed message when the list can’t be read', async () => {
    const t = fakeTinfoil();
    t.fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 500 }));
    await expect(adapterFor(t).listModels(signal())).rejects.toThrow('Tinfoil’s model list couldn’t be read.');
    t.fetchMock.mockImplementationOnce(async () => {
      throw new Error('ECONNREFUSED tk-SECRETMARKER');
    });
    await expect(adapterFor(t).listModels(signal())).rejects.toThrow('Tinfoil’s model list couldn’t be reached.');
  });
});

describe('mapTinfoilError', () => {
  it('maps errors', () => {
    const h = new Headers();
    expect(mapTinfoilError(401, '', h)).toEqual({ kind: 'bad-key' });
    expect(mapTinfoilError(402, '{"error":{"type":"insufficient_quota"}}', h)).toEqual({ kind: 'no-balance' });
    expect(mapTinfoilError(429, '{"error":{"message":"Spend limit reached","type":"insufficient_quota"}}', h)).toEqual({ kind: 'no-balance' });
    expect(mapTinfoilError(429, '{"error":{"code":"insufficient_quota"}}', h)).toEqual({ kind: 'no-balance' });
    expect(mapTinfoilError(429, '{"error":{"type":"rate_limit_exceeded"}}', new Headers({ 'retry-after': '7' }))).toEqual({ kind: 'rate-limited', retryAfterMs: 7000 });
    expect(mapTinfoilError(429, 'not json, says insufficient_quota', h)).toEqual({ kind: 'rate-limited' });
    expect(mapTinfoilError(400, '{"error":{"message":"This model\'s maximum context length is 1048576 tokens"}}', h)).toEqual({ kind: 'server', status: 400, contextOverflow: true });
    expect(mapTinfoilError(400, '{"error":{"message":"bad"}}', h)).toEqual({ kind: 'server', status: 400 });
    expect(mapTinfoilError(503, '', h)).toEqual({ kind: 'server', status: 503 });
  });
});

describe('chat', () => {
  it('attests the router keylessly, then sends over TLS pinned to the verified key', async () => {
    const t = fakeTinfoil();
    const result = await adapterFor(t).chat(chatBody(), signal());
    expect(result.ok).toBe(true);
    expect(t.attestations).toHaveLength(1);
    expect(t.attestations[0].nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(t.attestations[0].headers.authorization).toBeUndefined();
    expect(t.verifyV3).toHaveBeenCalledTimes(1);
    expect(t.pinned).toHaveBeenCalledWith(FP);
    expect(t.chats).toHaveLength(1);
    expect(t.chats[0].fingerprint).toBe(FP);
    expect(t.chats[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(t.chats[0].headers['content-type']).toBe('application/json');
  });

  it('uses a fresh nonce for each attestation', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.verifyAttestation(MODEL, signal());
    vi.setSystemTime(new Date('2026-11-15T12:05:00Z'));
    await adapter.verifyAttestation(MODEL, signal());
    expect(t.attestations).toHaveLength(2);
    expect(t.attestations[0].nonce).not.toBe(t.attestations[1].nonce);
  });

  it('reuses the verification for 30 minutes, then attests again', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:29:59Z'));
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-15T12:30:00Z'));
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(2);
  });

  it('stops using a verification when its freshness runs out, if that comes first', async () => {
    const t = fakeTinfoil({ verified: () => ({ tlsPublicKeyFP: FP, codeTag: 'v1', freshnessExpiresAt: new Date('2026-11-15T12:10:00Z') }) });
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:09:59Z'));
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-15T12:10:00Z'));
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(2);
  });

  it('refuses a verification that is already past its freshness', async () => {
    const t = fakeTinfoil({ verified: () => ({ tlsPublicKeyFP: FP, codeTag: 'v1', freshnessExpiresAt: new Date('2026-11-15T11:00:00Z') }) });
    const result = await adapterFor(t).chat(chatBody(), signal());
    expect(result).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'stale' } });
    expect(t.chats).toHaveLength(0);
  });

  it('checks the router once for every model it serves', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody({ model: OTHER_MODEL }), signal());
    expect(t.attestations).toHaveLength(1);
    expect(t.chats.map((c) => c.body.model)).toEqual([MODEL, OTHER_MODEL]);
  });

  it('pins the new key after the router is attested again', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    t.setVerified(() => ({ tlsPublicKeyFP: FP2, codeTag: 'v2' }));
    vi.setSystemTime(new Date('2026-11-15T13:00:00Z'));
    await adapter.chat(chatBody(), signal());
    expect(t.chats.map((c) => c.fingerprint)).toEqual([FP, FP2]);
    expect(t.closed).toEqual([FP]);
  });

  it('verifyAttestation reuses a verification from the last minute, as adding a provider does after checkKey', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.checkKey(signal());
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: true });
    expect(t.attestations).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-15T12:01:00Z'));
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: true });
    expect(t.attestations).toHaveLength(2);
  });

  it('keeps the verification after a chat refused for the account or the request or a 5xx, and drops it after another 4xx', async () => {
    for (const [status, body, keeps] of [
      [401, '{}', true],
      [402, '{}', true],
      [429, '{"error":{"type":"insufficient_quota"}}', true],
      [429, '{}', true],
      [400, '{}', true],
      [413, '{}', true],
      [422, '{}', true],
      [404, '{}', false],
      [500, '{}', true],
      [503, '{}', true],
    ] as const) {
      const t = fakeTinfoil({ chat: () => new Response(body, { status }) });
      const adapter = adapterFor(t);
      await adapter.chat(chatBody(), signal());
      await adapter.chat(chatBody(), signal());
      expect([status, t.attestations.length, t.closed.length]).toEqual([status, keeps ? 1 : 2, keeps ? 0 : 2]);
    }
  });

  it('drops the verification when the pinned connection fails, so a new router key is picked up', async () => {
    let calls = 0;
    const t = fakeTinfoil({
      chat: () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return okChat();
      },
    });
    const adapter = adapterFor(t);
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'chat' } });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(t.attestations).toHaveLength(2);
    expect(t.closed).toEqual([FP]);
  });

  it('reports a pin mismatch as unreachable with detail pin, logs it as metadata and attests again', async () => {
    const log = vi.fn();
    let calls = 0;
    const t = fakeTinfoil({
      chat: () => {
        calls += 1;
        if (calls === 1) throw new PinMismatchError();
        return okChat();
      },
    });
    const adapter = adapterFor(t, { log });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'pin' } });
    expect(log).toHaveBeenCalledWith('confidential pin mismatch', { provider: 'tinfoil', model: MODEL });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(t.attestations).toHaveLength(2);
  });

  it('a failed chat leaves a newer key that another chat verified meanwhile', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const t = fakeTinfoil({
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          await held;
          return new Response('{}', { status: 404 });
        }
        return okChat();
      },
    });
    const adapter = adapterFor(t);
    const first = adapter.chat(chatBody(), signal());
    await vi.waitFor(() => expect(t.chats).toHaveLength(1));
    t.setVerified(() => ({ tlsPublicKeyFP: FP2, codeTag: 'v2' }));
    vi.setSystemTime(new Date('2026-11-15T13:00:00Z'));
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    release();
    expect(await first).toEqual({ ok: false, failure: { kind: 'server', status: 404 } });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(t.attestations).toHaveLength(2);
    expect(t.chats.map((c) => c.fingerprint)).toEqual([FP, FP2, FP2]);
    expect(t.closed).toEqual([FP]);
  });

  it('keeps the verification after a chat aborted while its reply is read', async () => {
    let hang = true;
    const t = fakeTinfoil({
      chat: () => (hang ? new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) })) : okChat()),
    });
    const adapter = adapterFor(t);
    const controller = new AbortController();
    const pending = adapter.chat(chatBody(), controller.signal);
    await vi.waitFor(() => expect(t.chats).toHaveLength(1));
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    hang = false;
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(t.attestations).toHaveLength(1);
  });

  it('returns attestation-failed with the layer and sends nothing when the document fails', async () => {
    const log = vi.fn();
    const t = fakeTinfoil({
      verified: () => {
        throw new VerificationError('measurement mismatch for https://example.invalid tk-SECRETMARKER', { layer: 'provenance' });
      },
    });
    const adapter = adapterFor(t, { log });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'provenance' } });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'provenance' });
    expect(t.chats).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'tinfoil', model: MODEL, outcome: 'failed:provenance', tcbStatus: null });
  });

  it('reads a layer it doesn’t know as other, and a usage error as verifier', async () => {
    const t = fakeTinfoil({
      verified: () => {
        throw new VerificationError('x', { layer: 'something new' });
      },
    });
    expect(await adapterFor(t).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'other' } });
    const u = fakeTinfoil({
      verified: () => {
        throw new UsageError('bad repo');
      },
    });
    expect(await adapterFor(u).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'verifier' } });
  });

  it('fails a document for another nonce', async () => {
    const t = fakeTinfoil({ attestation: () => new Response('00'.repeat(32)) });
    expect(await adapterFor(t).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'envelope' } });
  });

  it('fails a verification without a TLS key', async () => {
    for (const fp of [undefined, 'not-hex', 'AA'.repeat(31)]) {
      const t = fakeTinfoil({ verified: () => ({ tlsPublicKeyFP: fp, codeTag: 'v1' }) });
      expect(await adapterFor(t).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'tls-key' } });
      expect(t.chats).toHaveLength(0);
    }
  });

  it('reports an attestation endpoint that fails, rate-limits or can’t be reached as unreachable', async () => {
    for (const attestation of [
      (): Response => new Response('', { status: 503 }),
      (): Response => new Response('', { status: 429 }),
      (): Response => {
        throw new Error('ECONNRESET tk-SECRETMARKER');
      },
    ]) {
      const t = fakeTinfoil({ attestation });
      expect(await adapterFor(t).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'attestation' } });
      expect(await adapterFor(t).verifyAttestation(null, signal())).toEqual({ ok: false, detail: 'attestation', unreachable: true });
      expect(t.verifyV3).not.toHaveBeenCalled();
    }
  });

  it('fails a 4xx from the attestation endpoint as evidence that didn’t verify', async () => {
    const t = fakeTinfoil({ attestation: () => new Response('missing', { status: 404 }) });
    expect(await adapterFor(t).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'document' } });
    expect(t.verifyV3).not.toHaveBeenCalled();
  });

  it('reports a verifier that won’t load as unreachable', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t, {
      verifier: async () => {
        throw new Error('load failed');
      },
    });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'verifier unavailable' } });
  });

  it('returns at once when the caller aborts during attestation', async () => {
    const t = fakeTinfoil({ verified: () => new Promise<Verified>(() => undefined) });
    const controller = new AbortController();
    const pending = adapterFor(t).chat(chatBody(), controller.signal);
    await vi.waitUntil(() => t.verifyV3.mock.calls.length === 1);
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(t.chats).toHaveLength(0);
  });

  it('passes the signal to the attestation fetch', async () => {
    const t = fakeTinfoil();
    const controller = new AbortController();
    controller.abort();
    expect(await adapterFor(t).chat(chatBody(), controller.signal)).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
  });

  it('sends only the allowlisted request fields', async () => {
    const t = fakeTinfoil();
    await adapterFor(t).chat(
      chatBody({
        stream: false,
        user: 'person',
        logprobs: true,
        metadata: { a: 1 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], reasoning_content: 'x' }],
      }),
      signal()
    );
    expect(t.chats[0].body).toEqual({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'a\n\nb' }] });
  });

  it('returns 400 and sends nothing for content it won’t send', async () => {
    const t = fakeTinfoil();
    const result = await adapterFor(t).chat(chatBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }), signal());
    expect(result).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    expect(t.chats).toHaveLength(0);
    expect(await adapterFor(t).chat('not json', signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
  });

  it('passes a non-streamed reply through the reply allowlist', async () => {
    const t = fakeTinfoil();
    const result = await adapterFor(t).chat(chatBody(), signal());
    if (result.ok === false) throw new Error('chat failed');
    expect(await result.response.json()).toEqual({
      id: 'c1',
      object: 'chat.completion',
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
  });

  it('fails a non-streamed reply without choices and drops the verification', async () => {
    const t = fakeTinfoil({ chat: () => Response.json({ hello: 'world' }) });
    const adapter = adapterFor(t);
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'unreadable reply' } });
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(2);
  });

  it('marks a context overflow', async () => {
    const t = fakeTinfoil({ chat: () => new Response('{"error":{"message":"prompt is too long"}}', { status: 400 }) });
    expect(await adapterFor(t).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400, contextOverflow: true } });
  });

  it('streams chunks through the reply allowlist', async () => {
    const t = fakeTinfoil({
      chat: () =>
        sse([
          JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'He', extra: 1 }, logprobs: null }] }),
          JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }], usage: { completion_tokens: 2 } }),
          '[DONE]',
        ]),
    });
    const result = await adapterFor(t).chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('chat failed');
    expect(await result.response.text()).toBe(
      [
        `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'He' } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'c1', usage: { completion_tokens: 2 }, choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'llo' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
    );
  });

  it('fails the stream on an error chunk, settles failed and drops the verification', async () => {
    const t = fakeTinfoil({ chat: () => sse([JSON.stringify({ choices: [{ delta: { content: 'a' } }] }), JSON.stringify({ error: { message: 'boom' } })]) });
    const adapter = adapterFor(t);
    const result = await adapter.chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('chat failed');
    const text = await result.response.text();
    expect(text.endsWith(ERROR_EVENT)).toBe(true);
    expect(await result.failed).toEqual({ kind: 'mid-stream', detail: 'stream' });
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(2);
  });

  it('fails a stream that ends without [DONE]', async () => {
    const t = fakeTinfoil({ chat: () => sse([JSON.stringify({ choices: [{ delta: { content: 'a' } }] })]) });
    const result = await adapterFor(t).chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('chat failed');
    expect((await result.response.text()).endsWith(ERROR_EVENT)).toBe(true);
    expect(await result.failed).toEqual({ kind: 'mid-stream', detail: 'stream' });
  });

  it('aborts the upstream body on signal and keeps the verification', async () => {
    let cancelled = false;
    let streaming = true;
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`;
    const upstream = (): Response => {
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
    const t = fakeTinfoil({ chat: () => (streaming ? upstream() : okChat()) });
    const adapter = adapterFor(t);
    const controller = new AbortController();
    const result = await adapter.chat(chatBody({ stream: true }), controller.signal);
    if (result.ok === false) throw new Error('chat failed');
    expect(t.chats[0].signal).toBe(controller.signal);
    const reader = result.response.body!.getReader();
    await reader.read();
    const next = reader.read();
    controller.abort();
    await expect(next).rejects.toThrow();
    expect(cancelled).toBe(true);
    streaming = false;
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(1);
  });
});

/** A promise and its resolve, for holding a fake call until the test lets it finish. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets pending promise callbacks run; no timers involved. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('close', () => {
  it('closes the cached key’s pooled connections', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    adapter.close?.();
    expect(t.closed).toEqual([FP]);
  });

  it('pools nothing for an attestation that finishes after close, and still serves the chat that waited', async () => {
    const held = gate<Verified>();
    const t = fakeTinfoil({ verified: () => held.promise });
    const adapter = adapterFor(t);
    const pending = adapter.chat(chatBody(), signal());
    await flush();
    adapter.close?.();
    held.open({ tlsPublicKeyFP: FP, codeTag: 'v1' });
    expect((await pending).ok).toBe(true);
    expect(t.closed).toEqual([FP]);
  });
});

describe('concurrent attestations', () => {
  it('shares one attestation between chats that find no key', async () => {
    const held = gate<Verified>();
    const t = fakeTinfoil({ verified: () => held.promise });
    const adapter = adapterFor(t);
    const chats = [adapter.chat(chatBody(), signal()), adapter.chat(chatBody(), signal()), adapter.verifyAttestation(null, signal())];
    await flush();
    held.open({ tlsPublicKeyFP: FP, codeTag: 'v1' });
    const [a, b, check] = await Promise.all(chats);
    expect([a.ok, b.ok, check]).toEqual([true, true, { ok: true }]);
    expect(t.attestations).toHaveLength(1);
    expect(t.pinned).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached key usable while a refresh attests again', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:05:00Z'));
    const held = gate<Verified>();
    t.setVerified(() => held.promise as unknown as Verified);
    const refresh = adapter.verifyAttestation(null, signal());
    await flush();
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(t.chats.map((c) => c.fingerprint)).toEqual([FP, FP]);
    held.open({ tlsPublicKeyFP: FP2, codeTag: 'v2' });
    expect(await refresh).toEqual({ ok: true });
    await adapter.chat(chatBody(), signal());
    expect(t.chats.at(-1)?.fingerprint).toBe(FP2);
    expect(t.closed).toEqual([FP]);
  });

  it('drops the cached key when a refresh finds the router failing', async () => {
    const t = fakeTinfoil();
    const adapter = adapterFor(t);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:05:00Z'));
    t.setVerified(() => {
      throw new VerificationError('x', { layer: 'quote' });
    });
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: false, detail: 'quote' });
    expect(t.closed).toEqual([FP]);
  });

  it('lets one caller leave without stopping the attestation another still waits for', async () => {
    const held = gate<Verified>();
    const t = fakeTinfoil({ verified: () => held.promise });
    const adapter = adapterFor(t);
    const leaving = new AbortController();
    const first = adapter.chat(chatBody(), leaving.signal);
    const second = adapter.chat(chatBody(), signal());
    await flush();
    leaving.abort();
    expect(await first).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    held.open({ tlsPublicKeyFP: FP, codeTag: 'v1' });
    expect((await second).ok).toBe(true);
    expect(t.attestations).toHaveLength(1);
  });

  it('starts a new attestation once every caller has left, and the old one’s late result never replaces it', async () => {
    const slow = gate<Verified>();
    let calls = 0;
    const t = fakeTinfoil({
      verified: () => {
        calls += 1;
        return calls === 1 ? slow.promise : { tlsPublicKeyFP: FP2, codeTag: 'v2' };
      },
    });
    const adapter = adapterFor(t);
    const leaving = new AbortController();
    const first = adapter.chat(chatBody(), leaving.signal);
    await flush();
    leaving.abort();
    expect(await first).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    slow.open({ tlsPublicKeyFP: FP, codeTag: 'v1' });
    await flush();
    await adapter.chat(chatBody(), signal());
    expect(t.attestations).toHaveLength(2);
    expect(t.chats.map((c) => c.fingerprint)).toEqual([FP2, FP2]);
    expect(t.pinned).toHaveBeenCalledTimes(1);
  });
});

describe('other methods', () => {
  it('checkKey sends a one-token chat to the first model', async () => {
    const t = fakeTinfoil();
    expect(await adapterFor(t).checkKey(signal())).toEqual({ ok: true });
    expect(t.chats[0].body).toEqual({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false });
  });

  it('checkKey reports a bad key, and accepts a key whose account has no credit', async () => {
    expect(await adapterFor(fakeTinfoil({ chat: () => new Response('{}', { status: 401 }) })).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'bad-key' } });
    expect(await adapterFor(fakeTinfoil({ chat: () => new Response('{}', { status: 402 }) })).checkKey(signal())).toEqual({ ok: true });
  });

  it('checkKey reports a failed hardware check as such', async () => {
    const t = fakeTinfoil({
      verified: () => {
        throw new VerificationError('x', { layer: 'quote' });
      },
    });
    expect(await adapterFor(t).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'quote' } });
  });

  it('testToolCall sends one tool and reports a tool call', async () => {
    const t = fakeTinfoil({
      chat: () =>
        Response.json({ choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 't', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] }),
    });
    expect(await adapterFor(t).testToolCall(signal())).toBe(true);
    expect(t.chats[0].body.tools).toEqual([
      { type: 'function', function: { name: 'get_current_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(await adapterFor(fakeTinfoil()).testToolCall(signal())).toBe(false);
  });

  it('readBalance returns null', async () => {
    expect(await adapterFor(fakeTinfoil()).readBalance(signal())).toBeNull();
  });

  it('logs metadata only and never the key', async () => {
    const log = vi.fn();
    const adapter = adapterFor(fakeTinfoil(), { log });
    await adapter.checkKey(signal());
    await adapter.testToolCall(signal());
    const failing = adapterFor(fakeTinfoil({ chat: () => new Response('tk-SECRETMARKER', { status: 500 }) }), { log });
    await failing.chat(chatBody(), signal());
    expect(log).toHaveBeenCalled();
    for (const args of log.mock.calls) expect(JSON.stringify(args)).not.toContain('SECRETMARKER');
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'tinfoil', model: MODEL, outcome: 'verified', tcbStatus: null, release: 'v0.0.176' });
  });
});
