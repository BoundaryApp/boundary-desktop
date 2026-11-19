import { afterEach } from 'vitest';

/**
 * Unit tests run offline. A `fetch` to anything but this machine fails the way an offline
 * request does, and the test that made it fails afterwards, naming the URL: otherwise a test
 * quietly depends on the network and takes as long as the real service does to answer.
 * A test that means to exercise the offline path stubs `fetch` itself (`vi.stubGlobal`).
 * Loopback stays open for tests that start their own server, and non-HTTP URLs (`data:`, which
 * some libraries use to load WebAssembly) never leave the process.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const realFetch = globalThis.fetch;
const blocked: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const { protocol, hostname } = new URL(url);
  if ((protocol !== 'http:' && protocol !== 'https:') || LOOPBACK.has(hostname)) return realFetch(input, init);
  blocked.push(url);
  throw new TypeError(`fetch failed: unit tests run offline (${url})`);
}) as typeof fetch;

afterEach(() => {
  if (blocked.length === 0) return;
  const urls = blocked.splice(0);
  throw new Error(
    `This test tried to reach the network: ${urls.join(', ')}. Stub fetch for it (vi.stubGlobal('fetch', …)).`
  );
});
