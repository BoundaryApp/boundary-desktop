import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attestPrivatemode, classifyClientError, parseSecret, type PrivatemodeWasm, type PrivatemodeWasmClient } from '../privatemodeAttestation';

/**
 * The attestation against a stand-in for Privatemode's WebAssembly client. The stand-in follows
 * the client's API in `sdk/wasm/main.go` (privatemode-public, MIT): `initialize` attests and
 * exchanges the secret, `updateSecret` makes it current, `exportSecret` returns JSON, `close`
 * frees the client. Errors carry the client's own Go error text.
 */

const MANIFEST = readFileSync(path.join(__dirname, 'fixtures', 'manifest.json'));
/** v1.64.0's manifest, byte for byte as the CDN and the GitHub release serve it. */
const MANIFEST_SHA256 = 'd63eb5cf91cb3079fe25a848573a4d0e9d869f462dab4f71fd02bdb372f8e833';
const MISMATCH = 'active manifest does not match expected manifest';
const API_KEY = 'pm-SECRETMARKER';
const NOW = Date.parse('2026-11-15T12:00:00Z');
const SECRET_JSON = JSON.stringify({ id: 'secret-id-1', data: Buffer.alloc(32, 3).toString('base64'), expiresAtUnix: NOW / 1000 + 45 * 60 });

function standIn(overrides: Partial<PrivatemodeWasmClient> = {}) {
  const calls: string[] = [];
  const initialize = vi.fn(async (..._args: unknown[]) => {
    calls.push('initialize');
  });
  const client: PrivatemodeWasmClient = {
    initialize,
    updateSecret: vi.fn(async () => {
      calls.push('updateSecret');
    }),
    exportSecret: vi.fn(() => {
      calls.push('exportSecret');
      return SECRET_JSON;
    }),
    close: vi.fn(() => {
      calls.push('close');
    }),
    ...overrides,
  };
  const wasm: PrivatemodeWasm = { version: 'v1.64.0', manifestMismatch: MISMATCH, createClient: () => client };
  return { wasm, client, calls, initialize };
}

function cdn(response: () => Response | Promise<Response> = () => new Response(MANIFEST)) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    expect(String(input)).toBe('https://cdn.confidential.cloud/privatemode/v2/manifest.json');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    return response();
  });
}

const run = (wasm: PrivatemodeWasm, fetchImpl = cdn(), signal = new AbortController().signal, manifestPins: readonly string[] = [MANIFEST_SHA256]) =>
  attestPrivatemode({ apiKey: API_KEY, manifestPins, fetch: fetchImpl as unknown as typeof fetch, wasm: async () => wasm, signal, now: NOW });

describe('attestPrivatemode', () => {
  it('fetches the manifest keylessly, attests with it, then exports and closes', async () => {
    const s = standIn();
    const result = await run(s.wasm);
    expect(result).toEqual({
      ok: true,
      version: 'v1.64.0',
      manifestSha256: MANIFEST_SHA256,
      secret: { id: 'secret-id-1', data: new Uint8Array(Buffer.alloc(32, 3)), expiresAt: NOW + 45 * 60 * 1000 },
    });
    expect(s.calls).toEqual(['initialize', 'updateSecret', 'exportSecret', 'close']);
    expect(s.initialize).toHaveBeenCalledWith(MANIFEST.toString('base64'), 'apiKey', API_KEY, 'https://api.privatemode.ai', false);
  });

  it('reports a CDN that fails, rate-limits or can’t be reached as unreachable, without starting the client', async () => {
    for (const response of [() => new Response('', { status: 503 }), () => new Response('', { status: 429 }), (): Response => {
      throw new Error('ENOTFOUND');
    }]) {
      const s = standIn();
      expect(await run(s.wasm, cdn(response))).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'manifest' } });
      expect(s.initialize).not.toHaveBeenCalled();
    }
  });

  it('fails a pinned manifest that isn’t a JSON object', async () => {
    const s = standIn();
    const pin = createHash('sha256').update('[1]').digest('hex');
    expect(await run(s.wasm, cdn(() => new Response('[1]')), undefined, [pin])).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'manifest' },
      manifestSha256: pin,
    });
    expect(s.initialize).not.toHaveBeenCalled();
  });

  it('refuses a manifest whose exact bytes aren’t pinned, without starting the client', async () => {
    // The same JSON with one more trailing newline: equal as JSON, a different digest.
    const reformatted = Buffer.concat([MANIFEST, Buffer.from('\n')]);
    const s = standIn();
    expect(await run(s.wasm, cdn(() => new Response(reformatted)))).toEqual({
      ok: false,
      failure: { kind: 'attestation-failed', detail: 'manifest-unpinned' },
      manifestSha256: createHash('sha256').update(reformatted).digest('hex'),
    });
    expect(s.initialize).not.toHaveBeenCalled();
    const t = standIn();
    expect((await run(t.wasm, cdn(), undefined, [])).ok).toBe(false);
    expect(t.initialize).not.toHaveBeenCalled();
  });

  it('reports a client that won’t load as unreachable', async () => {
    const result = await attestPrivatemode({
      apiKey: API_KEY,
      manifestPins: [MANIFEST_SHA256],
      fetch: cdn() as unknown as typeof fetch,
      wasm: async () => {
        throw new Error('no wasm');
      },
      signal: new AbortController().signal,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'verifier unavailable' } });
  });

  it('maps the client’s errors and closes it', async () => {
    const cases: [string, unknown][] = [
      [`initializing client: offering credential to secret manager: validating attestation: ${MISMATCH}`, { kind: 'attestation-failed', detail: 'manifest-mismatch' }],
      ['initializing client: doing attest request: Unauthorized (status code: 401)', { kind: 'bad-key' }],
      ['updating secret: unexpected status code: 401', { kind: 'bad-key' }],
      ['updating secret: unexpected status code 401: invalid key', { kind: 'bad-key' }],
      ['updating secret: unexpected status code: 4010', { kind: 'attestation-failed', detail: 'verifier' }],
      ['initializing client: doing attest request: unexpected status code: 402', { kind: 'no-balance' }],
      ['initializing client: doing attest request: unexpected status code: 503', { kind: 'unreachable', detail: 'attestation' }],
      ['initializing client: doing attest request: unexpected status code: 429', { kind: 'unreachable', detail: 'attestation' }],
      ['initializing client: doing attest request: unexpected status code: 404', { kind: 'attestation-failed', detail: 'verifier' }],
      ['initializing client: getting secret: unexpected status code 402: {"error":"quota"}', { kind: 'no-balance' }],
      ['initializing client: doing attest request: doing request: Post "https://api.privatemode.ai/x": dial tcp', { kind: 'unreachable', detail: 'attestation' }],
      ['initializing client: context deadline exceeded', { kind: 'unreachable', detail: 'attestation' }],
      ['initializing client: validating attestation: report signature invalid', { kind: 'attestation-failed', detail: 'verifier' }],
    ];
    for (const [message, failure] of cases) {
      const s = standIn({ initialize: async () => Promise.reject(new Error(message)) });
      expect([message, await run(s.wasm)]).toEqual([message, { ok: false, failure, manifestSha256: MANIFEST_SHA256 }]);
      expect(s.client.close).toHaveBeenCalledTimes(1);
    }
  });

  it('fails an exported secret that isn’t 32 bytes, or has expired', async () => {
    const short = standIn({ exportSecret: () => JSON.stringify({ id: 'x', data: Buffer.alloc(16).toString('base64'), expiresAtUnix: NOW / 1000 + 60 }) });
    expect(await run(short.wasm)).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'secret' }, manifestSha256: MANIFEST_SHA256 });
    const expired = standIn({ exportSecret: () => JSON.stringify({ id: 'x', data: Buffer.alloc(32).toString('base64'), expiresAtUnix: NOW / 1000 }) });
    expect(await run(expired.wasm)).toEqual({ ok: false, failure: { kind: 'attestation-failed', detail: 'secret-expired' }, manifestSha256: MANIFEST_SHA256 });
  });

  it('returns at once on abort and closes the client when its work settles', async () => {
    let finish!: () => void;
    let started!: () => void;
    let closed!: () => void;
    const initializeCalled = new Promise<void>((resolve) => (started = resolve));
    const closeCalled = new Promise<void>((resolve) => (closed = resolve));
    const s = standIn({
      initialize: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          started();
        }),
      close: vi.fn(() => closed()),
    });
    const controller = new AbortController();
    const pending = run(s.wasm, cdn(), controller.signal);
    await initializeCalled;
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(s.client.close).not.toHaveBeenCalled();
    finish();
    await closeCalled;
    expect(s.client.close).toHaveBeenCalledTimes(1);
  });

  it('passes the signal to the manifest fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = standIn();
    expect(await run(s.wasm, cdn(), controller.signal)).toEqual({ ok: false, failure: { kind: 'unreachable', detail: 'aborted' } });
    expect(s.initialize).not.toHaveBeenCalled();
  });
});

describe('parseSecret and classifyClientError', () => {
  it('reads only well-formed secrets', () => {
    expect(parseSecret(SECRET_JSON)).not.toBeNull();
    for (const bad of ['', '{}', '{"id":"","data":"","expiresAtUnix":1}', '{"id":"a","data":"!!","expiresAtUnix":1}', '{"id":"a","data":"AAAA","expiresAtUnix":"1"}']) {
      expect(parseSecret(bad)).toBeNull();
    }
  });

  it('never returns the error text', () => {
    const failure = classifyClientError('something with pm-SECRETMARKER and https://x', MISMATCH);
    expect(JSON.stringify(failure)).not.toContain('SECRETMARKER');
  });
});
