import { describe, expect, it, vi } from 'vitest';
import { wakeHermesBridgeServer } from '../hermesWake';

const reply = (status: number) => vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));

describe('wakeHermesBridgeServer', () => {
  it('posts to the reconnect endpoint with the API key', async () => {
    const fetchImpl = reply(202);
    const result = await wakeHermesBridgeServer({ apiBaseUrl: 'http://127.0.0.1:8643/v1', apiKey: 'k', fetchImpl });
    expect(result.outcome).toBe('woken');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8643/v1/mcp/servers/boundary/reconnect');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('treats a 404 as a stack without the endpoint, and never throws', async () => {
    expect((await wakeHermesBridgeServer({ apiBaseUrl: 'http://x/v1', apiKey: 'k', fetchImpl: reply(404) })).outcome).toBe('unsupported');
    expect((await wakeHermesBridgeServer({ apiBaseUrl: 'http://x/v1', apiKey: 'k', fetchImpl: reply(401) })).outcome).toBe('failed');
    const down = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await wakeHermesBridgeServer({ apiBaseUrl: 'http://x/v1', apiKey: 'k', fetchImpl: down })).toEqual({
      outcome: 'failed',
      detail: 'ECONNREFUSED',
    });
  });

  it('skips the call without a key', async () => {
    const fetchImpl = reply(202);
    expect((await wakeHermesBridgeServer({ apiBaseUrl: 'http://x/v1', apiKey: null, fetchImpl })).outcome).toBe('no-key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
