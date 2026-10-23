import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunpodGraphQLClient } from '../infrastructure/RunpodGraphQLClient';

describe('RunpodGraphQLClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('parses workerState array (LIVE time series) from myself.endpoints', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            myself: {
              endpoints: [
                {
                  id: 'ep-99',
                  gpuCount: 2,
                  workersMin: 0,
                  workersMax: 3,
                  pods: [],
                  workerState: [
                    {
                      initializing: 0,
                      throttled: 0,
                      idle: 0,
                      running: 0,
                      unhealthy: 0,
                    },
                    {
                      initializing: 1,
                      throttled: 2,
                      idle: 0,
                      running: 0,
                      unhealthy: 0,
                    },
                  ],
                },
              ],
            },
          },
        }),
        { status: 200 }
      )
    );

    const client = new RunpodGraphQLClient('key');
    const runtime = await client.fetchEndpointRuntime('ep-99');

    expect(runtime?.gpuCount).toBe(2);
    expect(runtime?.workerState?.throttled).toBe(2);
    expect(runtime?.workerState?.initializing).toBe(1);
  });

  it('returns null when endpoint not in list', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { myself: { endpoints: [{ id: 'other' }] } },
        }),
        { status: 200 }
      )
    );

    const client = new RunpodGraphQLClient('key');
    expect(await client.fetchEndpointRuntime('missing')).toBeNull();
  });
});
