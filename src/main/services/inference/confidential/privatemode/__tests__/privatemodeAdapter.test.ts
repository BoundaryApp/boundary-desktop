import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheSaltFor, createPrivatemodeAdapter, mapPrivatemodeError } from '../privatemodeAdapter';
import type { PrivatemodeWasm, PrivatemodeWasmClient } from '../privatemodeAttestation';
import { responder, SECRET } from './oaeResponder';

/**
 * The adapter against a fake Privatemode. The client is a stand-in for the WebAssembly module
 * (privatemodeAttestation.test.ts covers its error mapping; loadPrivatemodeWasm.test.ts loads the
 * real one). The chat endpoint opens each sealed request with the node:crypto responder in
 * oaeResponder.ts and seals its replies the same way, as Privatemode's proxy would.
 */

const BASE = 'https://api.privatemode.ai';
const MANIFEST_URL = 'https://cdn.confidential.cloud/privatemode/v2/manifest.json';
const ENCRYPTED = 'application/vnd.privatemode.encrypted-body';
const MODEL = 'glm-5.3-flash';
const OTHER_MODEL = 'gpt-oss-120b';
const API_KEY = 'pm-SECRETMARKER';
const VERSION = 'v1.64.0';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const ERROR_EVENT = 'data: {"error":{"message":"The provider’s reply couldn’t be read."}}\n\n';

type Server = ReturnType<typeof responder>;

interface ChatCall {
  headers: Record<string, string>;
  appHeader: { content_type?: string; headers?: Record<string, string> };
  body: Record<string, unknown>;
  server: Server;
  signal: AbortSignal | undefined;
}
type ChatHandler = (call: ChatCall) => Response | Promise<Response>;

function sealedReply(server: Server, contentType: string, body: string, status = 200): Response {
  return new Response(new Uint8Array(server.unary(contentType, body)), {
    status,
    headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': server.responseHeader },
  });
}

function okChat(call: ChatCall): Response {
  return sealedReply(
    call.server,
    'application/json',
    JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      model: MODEL,
      extra: 'dropped',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok', audio: { data: 'x' } }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    })
  );
}

/** A sealed event stream: the app header, one frame per event, then the empty final frame. */
function sealedSse(server: Server, events: string[], opts: { contentType?: string; final?: boolean } = {}): Response {
  const parts = [server.seal(JSON.stringify({ content_type: opts.contentType ?? 'text/event-stream' }), false)];
  for (const event of events) parts.push(server.seal(`data: ${event}\n\n`, false));
  if (opts.final !== false) parts.push(server.seal('', true));
  return new Response(new Uint8Array(Buffer.concat(parts)), { headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': server.responseHeader } });
}

function secretJson(expiresAtUnix: number, id = 'secret-1'): string {
  return JSON.stringify({ id, data: SECRET.toString('base64'), expiresAtUnix });
}

const MANIFEST_BODY = '{"ReferenceValues":{}}';
const MANIFEST_PIN = createHash('sha256').update(MANIFEST_BODY).digest('hex');

function fakePrivatemode(opts: { chat?: ChatHandler; initialize?: () => Promise<void>; secret?: () => string; manifest?: string } = {}) {
  const chats: ChatCall[] = [];
  const initialize = vi.fn(async (..._args: unknown[]): Promise<void> => (opts.initialize ? opts.initialize() : undefined));
  let secret = opts.secret ?? ((): string => secretJson(Math.floor(Date.now() / 1000) + 45 * 60));
  const client: PrivatemodeWasmClient = {
    initialize,
    updateSecret: async () => undefined,
    exportSecret: () => secret(),
    close: () => undefined,
  };
  const wasm: PrivatemodeWasm = { version: VERSION, manifestMismatch: 'active manifest does not match expected manifest', createClient: () => client };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    if (url === MANIFEST_URL) return new Response(opts.manifest ?? MANIFEST_BODY);
    if (url === `${BASE}/v1/models`) return Response.json({ data: [{ id: MODEL, tasks: ['generate', 'tool_calling'] }, { id: 'other', tasks: [] }, { id: OTHER_MODEL }] });
    if (url !== `${BASE}/v1/chat/completions`) throw new Error(`unexpected fetch ${url}`);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const server = responder(headers['privatemode-oae-request-header']);
    const opened = server.openRequest(init?.body as Uint8Array);
    const call: ChatCall = {
      headers,
      appHeader: opened.header as ChatCall['appHeader'],
      body: JSON.parse(opened.body) as Record<string, unknown>,
      server,
      signal: init?.signal ?? undefined,
    };
    chats.push(call);
    return (opts.chat ?? okChat)(call);
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    fetchMock: fetchImpl,
    wasm,
    initialize,
    chats,
    setSecret(next: () => string): void {
      secret = next;
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;
const chatBody = (extra: Record<string, unknown> = {}): string => JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Hello there' }], ...extra });

function adapterFor(p: ReturnType<typeof fakePrivatemode>, extra: Partial<Parameters<typeof createPrivatemodeAdapter>[0]> = {}) {
  return createPrivatemodeAdapter({ apiKey: API_KEY, models: [MODEL, OTHER_MODEL], manifestSha256: [MANIFEST_PIN], fetch: p.fetch, wasm: async () => p.wasm, ...extra });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cacheSaltFor', () => {
  it('is HMAC-SHA256 of a fixed label under the key, base64url, and differs per key', () => {
    const expected = createHmac('sha256', API_KEY).update('boundary privatemode cache salt').digest('base64url');
    expect(cacheSaltFor(API_KEY)).toBe(expected);
    expect(cacheSaltFor(API_KEY)).toHaveLength(43);
    expect(cacheSaltFor('pm-other')).not.toBe(expected);
    expect(cacheSaltFor(API_KEY)).not.toContain('SECRETMARKER');
  });
});

describe('mapPrivatemodeError', () => {
  it('maps errors', () => {
    const h = new Headers();
    expect(mapPrivatemodeError(401, '', h)).toEqual({ kind: 'bad-key' });
    expect(mapPrivatemodeError(402, '', h)).toEqual({ kind: 'no-balance' });
    expect(mapPrivatemodeError(429, '', new Headers({ 'retry-after': '3' }))).toEqual({ kind: 'rate-limited', retryAfterMs: 3000 });
    expect(mapPrivatemodeError(429, '', h)).toEqual({ kind: 'rate-limited' });
    expect(mapPrivatemodeError(400, '{"error":{"message":"maximum context length exceeded"}}', h)).toEqual({ kind: 'server', status: 400, contextOverflow: true });
    expect(mapPrivatemodeError(503, '', h)).toEqual({ kind: 'server', status: 503 });
  });
});

describe('listModels', () => {
  it('lists the catalog’s models with the key, leaving context and prices to the catalog', async () => {
    const p = fakePrivatemode();
    expect(await adapterFor(p).listModels(signal())).toEqual([
      { providerModelId: MODEL, contextLength: null, precision: null, price: null },
      { providerModelId: OTHER_MODEL, contextLength: null, precision: null, price: null },
    ]);
    const [, init] = p.fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${API_KEY}`);
  });

  it('throws a fixed message when the list can’t be read', async () => {
    const p = fakePrivatemode();
    p.fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 500 }));
    await expect(adapterFor(p).listModels(signal())).rejects.toThrow('Privatemode’s model list couldn’t be read.');
  });
});

describe('chat', () => {
  it('attests, then sends the body sealed with exactly the plain headers Privatemode needs', async () => {
    const p = fakePrivatemode();
    const result = await adapterFor(p).chat(chatBody(), signal());
    expect(result.ok).toBe(true);
    expect(p.initialize).toHaveBeenCalledTimes(1);
    expect(p.initialize).toHaveBeenCalledWith(expect.any(String), 'apiKey', API_KEY, BASE, false);
    expect(p.chats).toHaveLength(1);
    const { headers } = p.chats[0];
    expect(Object.keys(headers).sort()).toEqual([
      'authorization',
      'content-type',
      'privatemode-oae-request-header',
      'privatemode-secret-id',
      'privatemode-target-model',
      'privatemode-version',
    ]);
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['content-type']).toBe(ENCRYPTED);
    expect(headers['privatemode-oae-request-header']).toMatch(/^:[A-Za-z0-9+/]{43}=:$/);
    expect(headers['privatemode-secret-id']).toBe('secret-1');
    expect(headers['privatemode-version']).toBe(VERSION);
    expect(headers['privatemode-target-model']).toBe(MODEL);
  });

  it('seals the OCSP policy and version in the app header and the cache salt in the body', async () => {
    const p = fakePrivatemode();
    await adapterFor(p).chat(chatBody(), signal());
    expect(p.chats[0].appHeader).toEqual({
      content_type: 'application/json',
      headers: {
        'Privatemode-NVIDIA-OCSP-Policy': `rules=allow-good; revocation-time-not-before=${NOW / 1000}`,
        'Privatemode-Version': VERSION,
      },
    });
    expect(p.chats[0].body.cache_salt).toBe(cacheSaltFor(API_KEY));
  });

  it('uses a new request salt for every chat', async () => {
    const p = fakePrivatemode();
    const adapter = adapterFor(p);
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody(), signal());
    expect(p.chats[0].headers['privatemode-oae-request-header']).not.toBe(p.chats[1].headers['privatemode-oae-request-header']);
  });

  it('reuses the secret for 30 minutes, then attests again', async () => {
    const p = fakePrivatemode();
    const adapter = adapterFor(p);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:29:59Z'));
    await adapter.chat(chatBody(), signal());
    expect(p.initialize).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-15T12:30:00Z'));
    await adapter.chat(chatBody(), signal());
    expect(p.initialize).toHaveBeenCalledTimes(2);
  });

  it('stops using a secret a minute before its expiresAtUnix, if that comes first', async () => {
    const p = fakePrivatemode({ secret: () => secretJson(NOW / 1000 + 10 * 60) });
    const adapter = adapterFor(p);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:08:59Z'));
    await adapter.chat(chatBody(), signal());
    expect(p.initialize).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-15T12:09:00Z'));
    p.setSecret(() => secretJson(NOW / 1000 + 60 * 60, 'secret-2'));
    await adapter.chat(chatBody(), signal());
    expect(p.initialize).toHaveBeenCalledTimes(2);
    expect(p.chats.map((c) => c.headers['privatemode-secret-id'])).toEqual(['secret-1', 'secret-1', 'secret-2']);
  });

  it('refuses a secret that has already expired, or expires within a minute, and sends nothing', async () => {
    for (const expiresAtUnix of [NOW / 1000 - 1, NOW / 1000 + 60]) {
      const p = fakePrivatemode({ secret: () => secretJson(expiresAtUnix) });
      expect(await adapterFor(p).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'secret-expired' } });
      expect(p.chats).toHaveLength(0);
    }
  });

  it('checks the deployment once for every model it serves', async () => {
    const p = fakePrivatemode();
    const adapter = adapterFor(p);
    await adapter.chat(chatBody(), signal());
    await adapter.chat(chatBody({ model: OTHER_MODEL }), signal());
    expect(p.initialize).toHaveBeenCalledTimes(1);
    expect(p.chats.map((c) => c.headers['privatemode-target-model'])).toEqual([MODEL, OTHER_MODEL]);
  });

  it('verifyAttestation reuses a check from the last minute, as adding a provider does after checkKey', async () => {
    const p = fakePrivatemode();
    const adapter = adapterFor(p);
    await adapter.checkKey(signal());
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: true });
    expect(p.initialize).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-15T12:01:00Z'));
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: true });
    expect(p.initialize).toHaveBeenCalledTimes(2);
  });

  it('opens a sealed error reply and maps it', async () => {
    const p = fakePrivatemode({ chat: (call) => sealedReply(call.server, 'application/json', '{"error":{"message":"prompt is too long"}}', 400) });
    expect(await adapterFor(p).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400, contextOverflow: true } });
  });

  it('reads a plain error reply from outside the enclave as is', async () => {
    const p = fakePrivatemode({ chat: () => new Response('{"error":{"message":"maximum context length"}}', { status: 400, headers: { 'content-type': 'application/json' } }) });
    expect(await adapterFor(p).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400, contextOverflow: true } });
    const q = fakePrivatemode({ chat: () => new Response('nope', { status: 429, headers: { 'retry-after': '5' } }) });
    expect(await adapterFor(q).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'rate-limited', retryAfterMs: 5000 } });
  });

  it('reads a sealed error reply that won’t open as an empty body', async () => {
    const p = fakePrivatemode({
      chat: (call) => new Response('garbage', { status: 400, headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': call.server.responseHeader } }),
    });
    expect(await adapterFor(p).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
  });

  it('refuses an unsealed 2xx and drops the secret', async () => {
    let plain = true;
    const p = fakePrivatemode({ chat: (call) => (plain ? Response.json({ choices: [{ message: { content: 'not sealed' } }] }) : okChat(call)) });
    const adapter = adapterFor(p);
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'unsealed reply' } });
    plain = false;
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(p.initialize).toHaveBeenCalledTimes(2);
  });

  it('refuses a sealed 2xx without a usable response salt', async () => {
    const p = fakePrivatemode({ chat: (call) => new Response(new Uint8Array(call.server.unary('application/json', '{}')), { headers: { 'content-type': ENCRYPTED } }) });
    expect(await adapterFor(p).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'undecryptable reply' } });
  });

  it('refuses a reply sealed for another secret', async () => {
    const p = fakePrivatemode({
      chat: (call) => {
        const other = responder(call.headers['privatemode-oae-request-header'], Buffer.alloc(32, 9));
        return sealedReply(other, 'application/json', '{"choices":[]}');
      },
    });
    expect(await adapterFor(p).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'undecryptable reply' } });
  });

  it('keeps the secret after a chat refused for the account or the request or a 5xx, and drops it after another 4xx', async () => {
    for (const [status, keeps] of [
      [401, true],
      [402, true],
      [429, true],
      [400, true],
      [413, true],
      [422, true],
      [404, false],
      [403, false],
      [500, true],
      [502, true],
      [503, true],
    ] as const) {
      const p = fakePrivatemode({ chat: () => new Response('{}', { status }) });
      const adapter = adapterFor(p);
      await adapter.chat(chatBody(), signal());
      await adapter.chat(chatBody(), signal());
      expect([status, p.initialize.mock.calls.length]).toEqual([status, keeps ? 1 : 2]);
    }
  });

  it('a failed chat leaves a newer secret that another chat attested meanwhile', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const p = fakePrivatemode({
      chat: async (call) => {
        calls += 1;
        if (calls === 1) {
          await held;
          return new Response('{}', { status: 404 });
        }
        return okChat(call);
      },
    });
    const adapter = adapterFor(p);
    const first = adapter.chat(chatBody(), signal());
    await vi.waitFor(() => expect(p.chats).toHaveLength(1));
    vi.setSystemTime(new Date('2026-11-15T12:31:00Z'));
    p.setSecret(() => secretJson(Math.floor(Date.now() / 1000) + 45 * 60, 'secret-2'));
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    release();
    expect(await first).toEqual({ ok: false, failure: { kind: 'server', status: 404 } });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(p.initialize).toHaveBeenCalledTimes(2);
    expect(p.chats.map((c) => c.headers['privatemode-secret-id'])).toEqual(['secret-1', 'secret-2', 'secret-2']);
  });

  it('keeps the secret when the chat can’t be sent, so retries during an outage don’t attest again', async () => {
    let calls = 0;
    const p = fakePrivatemode({
      chat: (call) => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET pm-SECRETMARKER');
        return okChat(call);
      },
    });
    const adapter = adapterFor(p);
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'chat' } });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    expect(p.initialize).toHaveBeenCalledTimes(1);
  });

  it('keeps the secret after a non-streamed reply over the limit or cut off while read', async () => {
    for (const reply of [
      (): Response => new Response(new Uint8Array(16 * 1024 * 1024 + 2048), { headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': ':' + Buffer.alloc(32).toString('base64') + ':' } }),
      (call: ChatCall): Response =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(call.server.seal(JSON.stringify({ content_type: 'application/json' }), false)));
              controller.error(new Error('ECONNRESET'));
            },
          }),
          { headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': call.server.responseHeader } }
        ),
    ]) {
      let first = true;
      const p = fakePrivatemode({
        chat: (call) => {
          if (!first) return okChat(call);
          first = false;
          return reply(call);
        },
      });
      const adapter = adapterFor(p);
      expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'mid-stream', detail: 'unreadable reply' } });
      expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
      expect(p.initialize).toHaveBeenCalledTimes(1);
    }
  });

  it('reports attestation failures without sending, and logs metadata only', async () => {
    const log = vi.fn();
    const p = fakePrivatemode({ initialize: () => Promise.reject(new Error('initializing client: doing attest request: Unauthorized (status code: 401)')) });
    const adapter = adapterFor(p, { log });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'bad-key' } });
    expect(p.chats).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'privatemode', model: MODEL, outcome: 'bad-key', tcbStatus: null, manifestSha256: MANIFEST_PIN });
    const q = fakePrivatemode({ initialize: () => Promise.reject(new Error('validating attestation: report signature invalid')) });
    expect(await adapterFor(q).verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'verifier' });
  });

  it('refuses a manifest the catalog doesn’t pin before the client runs, and logs its digest', async () => {
    const log = vi.fn();
    const rotated = '{"ReferenceValues":{"snp":[]}}';
    const p = fakePrivatemode({ manifest: rotated });
    const adapter = adapterFor(p, { log });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'manifest-unpinned' } });
    expect(await adapter.verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'manifest-unpinned' });
    expect(await adapter.checkKey(signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'manifest-unpinned' } });
    expect(p.initialize).not.toHaveBeenCalled();
    expect(p.chats).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('confidential attestation', {
      provider: 'privatemode',
      model: MODEL,
      outcome: 'failed:manifest-unpinned',
      tcbStatus: null,
      manifestSha256: createHash('sha256').update(rotated).digest('hex'),
    });
  });

  it('accepts any manifest in the pin list and refuses every manifest with an empty list', async () => {
    const p = fakePrivatemode();
    expect((await adapterFor(p, { manifestSha256: ['0'.repeat(64), MANIFEST_PIN] }).chat(chatBody(), signal())).ok).toBe(true);
    const q = fakePrivatemode();
    expect(await adapterFor(q, { manifestSha256: [] }).chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'manifest-unpinned' } });
    expect(q.initialize).not.toHaveBeenCalled();
  });

  it('reports a client that won’t load as unreachable', async () => {
    const p = fakePrivatemode();
    const adapter = adapterFor(p, {
      wasm: async () => {
        throw new Error('no wasm');
      },
    });
    expect(await adapter.chat(chatBody(), signal())).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'verifier unavailable' } });
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: false, detail: 'verifier unavailable', unreachable: true });
  });

  it('returns at once when the caller aborts during attestation', async () => {
    let started!: () => void;
    const initializeCalled = new Promise<void>((resolve) => (started = resolve));
    const p = fakePrivatemode({
      initialize: () => {
        started();
        return new Promise<void>(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = adapterFor(p).chat(chatBody(), controller.signal);
    await initializeCalled;
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(p.chats).toHaveLength(0);
  });

  it('sends only the allowlisted request fields, plus the cache salt', async () => {
    const p = fakePrivatemode();
    await adapterFor(p).chat(
      chatBody({
        stream: false,
        user: 'person',
        logprobs: true,
        cache_salt: 'from-hermes',
        metadata: { a: 1 },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], reasoning_content: 'x' }],
      }),
      signal()
    );
    expect(p.chats[0].body).toEqual({ model: MODEL, stream: false, messages: [{ role: 'user', content: 'a\n\nb' }], cache_salt: cacheSaltFor(API_KEY) });
  });

  it('returns 400 and sends nothing for content it won’t send', async () => {
    const p = fakePrivatemode();
    const result = await adapterFor(p).chat(chatBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }), signal());
    expect(result).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    expect(await adapterFor(p).chat('not json', signal())).toEqual({ ok: false, failure: { kind: 'server', status: 400 } });
    expect(p.chats).toHaveLength(0);
    expect(p.initialize).not.toHaveBeenCalled();
  });

  it('opens a non-streamed reply and passes it through the reply allowlist', async () => {
    const p = fakePrivatemode();
    const result = await adapterFor(p).chat(chatBody(), signal());
    if (result.ok === false) throw new Error('chat failed');
    expect(await result.response.json()).toEqual({
      id: 'c1',
      object: 'chat.completion',
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    });
  });

  it('fails a reply without choices, or one cut off before its final frame, and drops the secret', async () => {
    for (const reply of [
      (call: ChatCall): Response => sealedReply(call.server, 'application/json', '{"hello":"world"}'),
      (call: ChatCall): Response =>
        new Response(new Uint8Array(call.server.seal(JSON.stringify({ content_type: 'application/json' }), false)), {
          headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': call.server.responseHeader },
        }),
    ]) {
      let first = true;
      const p = fakePrivatemode({
        chat: (call) => {
          if (!first) return okChat(call);
          first = false;
          return reply(call);
        },
      });
      const adapter = adapterFor(p);
      const result = await adapter.chat(chatBody(), signal());
      expect(result.ok).toBe(false);
      await adapter.chat(chatBody(), signal());
      expect(p.initialize).toHaveBeenCalledTimes(2);
    }
  });

  it('opens a stream frame by frame and passes chunks through the reply allowlist', async () => {
    const p = fakePrivatemode({
      chat: (call) =>
        sealedSse(call.server, [
          JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'He', extra: 1 }, logprobs: null }] }),
          JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }], usage: { completion_tokens: 2 } }),
          '[DONE]',
        ]),
    });
    const result = await adapterFor(p).chat(chatBody({ stream: true }), signal());
    if (result.ok === false) throw new Error('chat failed');
    expect(await result.response.text()).toBe(
      [
        `data: ${JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'He' } }] })}\n\n`,
        `data: ${JSON.stringify({ id: 'c1', usage: { completion_tokens: 2 }, choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'llo' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
    );
  });

  it('fails a stream on an error chunk, a missing final frame or a non-stream app header, and drops the secret', async () => {
    const chunk = JSON.stringify({ choices: [{ delta: { content: 'a' } }] });
    for (const reply of [
      (call: ChatCall): Response => sealedSse(call.server, [chunk, JSON.stringify({ error: { message: 'boom' } })]),
      // Cut off before [DONE]: once [DONE] has opened, the stream is complete and the rest is cancelled.
      (call: ChatCall): Response => sealedSse(call.server, [chunk], { final: false }),
      (call: ChatCall): Response => sealedSse(call.server, [chunk, '[DONE]'], { contentType: 'application/json' }),
    ]) {
      let first = true;
      const p = fakePrivatemode({
        chat: (call) => {
          if (!first) return okChat(call);
          first = false;
          return reply(call);
        },
      });
      const adapter = adapterFor(p);
      const result = await adapter.chat(chatBody({ stream: true }), signal());
      if (result.ok === false) throw new Error('chat failed');
      expect((await result.response.text()).endsWith(ERROR_EVENT)).toBe(true);
      expect(await result.failed).toEqual({ kind: 'mid-stream', detail: 'stream' });
      await adapter.chat(chatBody(), signal());
      expect(p.initialize).toHaveBeenCalledTimes(2);
    }
  });

  it('aborts the upstream body on signal and keeps the secret', async () => {
    let cancelled = false;
    let streaming = true;
    const upstream = (server: Server): Response => {
      const head = Buffer.concat([
        server.seal(JSON.stringify({ content_type: 'text/event-stream' }), false),
        server.seal(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`, false),
      ]);
      let sent = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(c): Promise<void> | void {
            if (sent) return new Promise<void>(() => undefined);
            sent = true;
            c.enqueue(new Uint8Array(head));
          },
          cancel(): void {
            cancelled = true;
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, { headers: { 'content-type': ENCRYPTED, 'privatemode-oae-response-header': server.responseHeader } });
    };
    const p = fakePrivatemode({ chat: (call) => (streaming ? upstream(call.server) : okChat(call)) });
    const adapter = adapterFor(p);
    const controller = new AbortController();
    const result = await adapter.chat(chatBody({ stream: true }), controller.signal);
    if (result.ok === false) throw new Error('chat failed');
    expect(p.chats[0].signal).toBe(controller.signal);
    const reader = result.response.body!.getReader();
    await reader.read();
    const next = reader.read();
    controller.abort();
    await expect(next).rejects.toThrow();
    expect(cancelled).toBe(true);
    streaming = false;
    await adapter.chat(chatBody(), signal());
    expect(p.initialize).toHaveBeenCalledTimes(1);
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

describe('concurrent attestations', () => {
  it('shares one attestation between chats that find no secret', async () => {
    const held = gate();
    const p = fakePrivatemode({ initialize: () => held.promise });
    const adapter = adapterFor(p);
    const calls = [adapter.chat(chatBody(), signal()), adapter.chat(chatBody(), signal()), adapter.verifyAttestation(null, signal())];
    await flush();
    held.open();
    const [a, b, check] = await Promise.all(calls);
    expect([a.ok, b.ok, check]).toEqual([true, true, { ok: true }]);
    expect(p.initialize).toHaveBeenCalledTimes(1);
  });

  it('keeps the current secret usable while a refresh attests again', async () => {
    let hold: Promise<void> | null = null;
    const p = fakePrivatemode({ initialize: () => hold ?? Promise.resolve() });
    const adapter = adapterFor(p);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:05:00Z'));
    const held = gate();
    hold = held.promise;
    p.setSecret(() => secretJson(Math.floor(Date.now() / 1000) + 45 * 60, 'secret-2'));
    const refresh = adapter.verifyAttestation(null, signal());
    await flush();
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    held.open();
    expect(await refresh).toEqual({ ok: true });
    await adapter.chat(chatBody(), signal());
    expect(p.chats.map((c) => c.headers['privatemode-secret-id'])).toEqual(['secret-1', 'secret-1', 'secret-2']);
  });

  it('drops the current secret when a refresh finds the deployment failing', async () => {
    let failing = false;
    const p = fakePrivatemode({ initialize: async () => (failing ? Promise.reject(new Error('active manifest does not match expected manifest')) : undefined) });
    const adapter = adapterFor(p);
    await adapter.chat(chatBody(), signal());
    vi.setSystemTime(new Date('2026-11-15T12:05:00Z'));
    failing = true;
    expect(await adapter.verifyAttestation(null, signal())).toEqual({ ok: false, detail: 'manifest-mismatch' });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(false);
    expect(p.chats).toHaveLength(1);
  });

  it('lets one caller leave without stopping the attestation another still waits for', async () => {
    const held = gate();
    const p = fakePrivatemode({ initialize: () => held.promise });
    const adapter = adapterFor(p);
    const leaving = new AbortController();
    const first = adapter.chat(chatBody(), leaving.signal);
    const second = adapter.chat(chatBody(), signal());
    await flush();
    leaving.abort();
    expect(await first).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    held.open();
    expect((await second).ok).toBe(true);
    expect(p.initialize).toHaveBeenCalledTimes(1);
  });

  it('starts a new attestation once every caller has left, and the old one’s late result never replaces it', async () => {
    const slow = gate();
    let calls = 0;
    const p = fakePrivatemode({
      initialize: () => {
        calls += 1;
        return calls === 1 ? slow.promise : Promise.resolve();
      },
    });
    let secretCalls = 0;
    p.setSecret(() => {
      secretCalls += 1;
      return secretJson(Math.floor(Date.now() / 1000) + 45 * 60, `secret-${secretCalls}`);
    });
    const adapter = adapterFor(p);
    const leaving = new AbortController();
    const first = adapter.chat(chatBody(), leaving.signal);
    await flush();
    leaving.abort();
    expect(await first).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect((await adapter.chat(chatBody(), signal())).ok).toBe(true);
    slow.open();
    await flush();
    await adapter.chat(chatBody(), signal());
    expect(p.initialize).toHaveBeenCalledTimes(2);
    expect(p.chats.map((c) => c.headers['privatemode-secret-id'])).toEqual(['secret-1', 'secret-1']);
  });
});

describe('other methods', () => {
  it('checkKey attests with the key and sends no chat', async () => {
    const p = fakePrivatemode();
    expect(await adapterFor(p).checkKey(signal())).toEqual({ ok: true });
    expect(p.initialize).toHaveBeenCalledTimes(1);
    expect(p.chats).toHaveLength(0);
  });

  it('checkKey reports a bad key and an account without credit, since neither can be attested', async () => {
    const bad = fakePrivatemode({ initialize: () => Promise.reject(new Error('Unauthorized (status code: 401)')) });
    expect(await adapterFor(bad).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'bad-key' } });
    const empty = fakePrivatemode({ initialize: () => Promise.reject(new Error('unexpected status code: 402')) });
    expect(await adapterFor(empty).checkKey(signal())).toEqual({ ok: false, failure: { kind: 'no-balance' } });
  });

  it('verifyAttestation reads an attestation refused for the account as a check that couldn’t run', async () => {
    for (const [message, detail] of [
      ['unexpected status code: 401', 'bad-key'],
      ['unexpected status code: 402', 'no-balance'],
      ['unexpected status code: 429', 'attestation'],
    ] as const) {
      const p = fakePrivatemode({ initialize: () => Promise.reject(new Error(message)) });
      expect(await adapterFor(p).verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail, unreachable: true });
    }
    const mismatch = fakePrivatemode({ initialize: () => Promise.reject(new Error('active manifest does not match expected manifest')) });
    expect(await adapterFor(mismatch).verifyAttestation(MODEL, signal())).toEqual({ ok: false, detail: 'manifest-mismatch' });
  });

  it('testToolCall sends one tool and reports a tool call', async () => {
    const p = fakePrivatemode({
      chat: (call) =>
        sealedReply(
          call.server,
          'application/json',
          JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 't', type: 'function', function: { name: 'get_current_time', arguments: '{}' } }] } }] })
        ),
    });
    expect(await adapterFor(p).testToolCall(signal())).toBe(true);
    expect(p.chats[0].body.tools).toEqual([
      { type: 'function', function: { name: 'get_current_time', description: 'Returns the current time.', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(await adapterFor(fakePrivatemode()).testToolCall(signal())).toBe(false);
  });

  it('readBalance returns null', async () => {
    expect(await adapterFor(fakePrivatemode()).readBalance(signal())).toBeNull();
  });

  it('logs metadata only and never the key', async () => {
    const log = vi.fn();
    const adapter = adapterFor(fakePrivatemode(), { log });
    await adapter.checkKey(signal());
    await adapter.testToolCall(signal());
    const failing = adapterFor(fakePrivatemode({ chat: () => new Response('pm-SECRETMARKER', { status: 500 }) }), { log });
    await failing.chat(chatBody(), signal());
    expect(log).toHaveBeenCalled();
    for (const args of log.mock.calls) expect(JSON.stringify(args)).not.toContain('SECRETMARKER');
    expect(log).toHaveBeenCalledWith('confidential attestation', { provider: 'privatemode', model: MODEL, outcome: 'verified', tcbStatus: null, release: VERSION, manifestSha256: MANIFEST_PIN });
  });
});
