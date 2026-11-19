import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_FETCH_TIMEOUT_MS, CATALOG_STALE_AFTER_MS, CatalogStore, verifyCatalogSignature } from '../catalogStore';

const URL = 'https://catalog.example.com/confidential/catalog.json';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');
const OTHER_PEM = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function catalogBytes(publishedAt: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 1,
      publishedAt,
      models: [{ id: 'qwen', name: 'Qwen 3.8 27B' }],
      providers: [],
      ...extra,
    })
  );
}

function signed(body: Buffer, key = privateKey): string {
  return sign(null, body, key).toString('base64');
}

/** Serves one catalog and its signature; `status` overrides the catalog's HTTP status. */
function server(body: Buffer, signature: string, status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${URL}.sig`) return new Response(signature, { status: 200 });
    if (url === URL) return new Response(new Uint8Array(body), { status });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let dir: string;
let now = Date.parse('2026-11-08T12:00:00Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'catalog-store-'));
  now = Date.parse('2026-11-08T12:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(fetchImpl: typeof fetch, publicKeyPem = PUBLIC_PEM): CatalogStore {
  return new CatalogStore({ dir, url: URL, publicKeyPem, fetchImpl, now: () => now });
}

describe('verifyCatalogSignature', () => {
  const body = catalogBytes('2026-11-08T00:00:00Z');
  it('accepts a valid signature', () => {
    expect(verifyCatalogSignature(body, signed(body), PUBLIC_PEM)).toBe(true);
  });
  it('rejects a flipped byte, the wrong key and garbage base64', () => {
    const flipped = Buffer.from(body);
    flipped[5] ^= 1;
    expect(verifyCatalogSignature(flipped, signed(body), PUBLIC_PEM)).toBe(false);
    expect(verifyCatalogSignature(body, signed(body), OTHER_PEM)).toBe(false);
    expect(verifyCatalogSignature(body, '%%%not base64%%%', PUBLIC_PEM)).toBe(false);
    expect(verifyCatalogSignature(body, signed(body), 'not a key')).toBe(false);
  });
});

describe('CatalogStore', () => {
  it('stores a verified catalog and returns it after a restart', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z');
    const first = await store(server(body, signed(body))).refresh();
    expect(first.lastRefresh?.status).toBe('updated');
    expect(first.catalog?.publishedAt).toBe('2026-11-08T00:00:00Z');

    const reloaded = await store(server(Buffer.from(''), '', 503)).load();
    expect(reloaded.catalog?.publishedAt).toBe('2026-11-08T00:00:00Z');
    expect(reloaded.lastRefresh).toBeNull();
  });

  it('rejects a bad signature and keeps the cached catalog', async () => {
    const good = catalogBytes('2026-11-08T00:00:00Z');
    await store(server(good, signed(good))).refresh();
    const newer = catalogBytes('2026-11-09T00:00:00Z');
    const result = await store(server(newer, signed(newer, other.privateKey))).refresh();
    expect(result.lastRefresh?.status).toBe('bad-signature');
    expect(result.catalog?.publishedAt).toBe('2026-11-08T00:00:00Z');
  });

  it('rejects an older validly signed catalog', async () => {
    const current = catalogBytes('2026-11-08T00:00:00Z');
    await store(server(current, signed(current))).refresh();
    const older = catalogBytes('2026-11-01T00:00:00Z');
    const result = await store(server(older, signed(older))).refresh();
    expect(result.lastRefresh?.status).toBe('rollback');
    expect(result.catalog?.publishedAt).toBe('2026-11-08T00:00:00Z');
  });

  it('reports unchanged for the same publishedAt', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z');
    const s = store(server(body, signed(body)));
    await s.refresh();
    expect((await s.refresh()).lastRefresh?.status).toBe('unchanged');
  });

  it('reports unreachable on a 503 and on a thrown fetch', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z');
    await store(server(body, signed(body))).refresh();
    const down = await store(server(body, signed(body), 503)).refresh();
    expect(down.lastRefresh?.status).toBe('unreachable');
    const thrown = await store((async () => {
      throw new Error('offline');
    }) as typeof fetch).refresh();
    expect(thrown.lastRefresh?.status).toBe('unreachable');
    expect(thrown.catalog?.publishedAt).toBe('2026-11-08T00:00:00Z');
  });

  it('reports invalid for a signed catalog that fails parseCatalog', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z', { format: 2 });
    const result = await store(server(body, signed(body))).refresh();
    expect(result.lastRefresh?.status).toBe('invalid');
    expect(result.catalog).toBeNull();
  });

  it('ignores a catalog edited on disk', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z');
    await store(server(body, signed(body))).refresh();
    const path = join(dir, 'confidential-catalog.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { body: string; signature: string };
    const edited = Buffer.from(envelope.body, 'base64').toString('utf8').replace('Qwen', 'Kwen');
    writeFileSync(path, JSON.stringify({ ...envelope, body: Buffer.from(edited).toString('base64') }));
    const loaded = await store(server(body, signed(body))).load();
    expect(loaded.catalog).toBeNull();
    expect(loaded.lastRefresh?.status).toBe('bad-signature');
  });

  it('marks the catalog stale after 7 days', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z');
    const s = store(server(body, signed(body)));
    await s.refresh();
    now = Date.parse('2026-11-08T00:00:00Z') + CATALOG_STALE_AFTER_MS;
    expect(s.snapshot().stale).toBe(false);
    now += 1;
    expect(s.snapshot().stale).toBe(true);
  });

  it('keeps the catalog and its signature together in one file', async () => {
    const body = catalogBytes('2026-11-08T00:00:00Z');
    await store(server(body, signed(body))).refresh();
    expect(readdirSync(dir)).toEqual(['confidential-catalog.json']);
  });

  it('runs concurrent refreshes one at a time, so the newest catalog wins on disk and in memory', async () => {
    const v2 = catalogBytes('2026-11-09T00:00:00Z');
    const v3 = catalogBytes('2026-11-10T00:00:00Z');
    const served = [v2, v3];
    let call = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const index = Math.floor(call++ / 2);
      const body = served[Math.min(index, 1)];
      await new Promise((resolve) => setImmediate(resolve));
      return String(input).endsWith('.sig') ? new Response(signed(body)) : new Response(new Uint8Array(body));
    }) as typeof fetch;
    const s = store(fetchImpl);
    const [first, second] = await Promise.all([s.refresh(), s.refresh()]);
    expect(first.lastRefresh?.status).toBe('updated');
    expect(second.catalog?.publishedAt).toBe('2026-11-10T00:00:00Z');
    expect(s.snapshot().catalog?.publishedAt).toBe('2026-11-10T00:00:00Z');
    expect((await store(server(Buffer.from(''), '', 503)).load()).catalog?.publishedAt).toBe('2026-11-10T00:00:00Z');
  });

  it('gives up on a fetch that hangs and lets the next refresh run', async () => {
    vi.useFakeTimers();
    try {
      const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as typeof fetch;
      const s = store(hanging);
      await s.load(); // the disk read is real I/O; do it before the fake clock moves
      const first = s.refresh();
      await vi.advanceTimersByTimeAsync(CATALOG_FETCH_TIMEOUT_MS);
      expect((await first).lastRefresh?.status).toBe('unreachable');
      const second = s.refresh();
      await vi.advanceTimersByTimeAsync(CATALOG_FETCH_TIMEOUT_MS);
      expect((await second).lastRefresh?.status).toBe('unreachable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the kept catalog when a signed refresh fails to parse', async () => {
    const good = catalogBytes('2026-11-08T00:00:00Z');
    await store(server(good, signed(good))).refresh();
    const bad = catalogBytes('2026-11-09T00:00:00Z', { format: 2 });
    const result = await store(server(bad, signed(bad))).refresh();
    expect(result.lastRefresh?.status).toBe('invalid');
    expect(result.catalog?.publishedAt).toBe('2026-11-08T00:00:00Z');
  });
});
