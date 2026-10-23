import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunpodApiClient } from '../infrastructure/RunpodApiClient';

describe('RunpodApiClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('createServerlessTemplate sends isServerless and env', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'tpl-new', name: 'test' }), { status: 200 })
    );

    const client = new RunpodApiClient('test-api-key');
    await client.createServerlessTemplate({
      name: 'boundary-test-vllm',
      imageName: 'runpod/worker-v1-vllm:v2.18.1',
      isServerless: true,
      env: {
        MODEL_NAME: 'meta-llama/Llama-3.3-70B-Instruct',
        HF_TOKEN: 'hf_secret',
        MAX_MODEL_LEN: '8192',
      },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://rest.runpod.io/v1/templates');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.isServerless).toBe(true);
    expect(body.volumeInGb).toBeUndefined();
    expect(body.env.HF_TOKEN).toBe('hf_secret');
    expect(body.env.MODEL_NAME).toContain('Llama');
  });

  it('updateTemplate uses PATCH', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'tpl-existing', name: 'test' }), { status: 200 })
    );

    const client = new RunpodApiClient('test-api-key');
    await client.updateTemplate('tpl-existing', {
      env: { HF_TOKEN: 'hf_updated' },
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain('/templates/tpl-existing');
    expect(init?.method).toBe('PATCH');
  });

  it('runpodFetch wraps network errors with context', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }));

    const client = new RunpodApiClient('test-api-key');
    await expect(
      client.createServerlessTemplate({
        name: 't',
        imageName: 'img',
        isServerless: true,
        env: {},
      })
    ).rejects.toThrow(/RunPod API request failed/);
  });

  it('getEndpoint requests includeWorkers', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'ep-1',
          gpuCount: 2,
          workers: [
            {
              id: 'w-1',
              desiredStatus: 'RUNNING',
              lastStatusChange: 'Started',
              gpu: { count: 2 },
              machine: { dataCenterId: 'US-CA-2' },
            },
          ],
        }),
        { status: 200 }
      )
    );

    const client = new RunpodApiClient('test-api-key');
    const ep = await client.getEndpoint('ep-1', { includeWorkers: true });

    expect(ep.id).toBe('ep-1');
    expect(ep.gpuCount).toBe(2);
    expect(ep.workers).toHaveLength(1);
    expect(ep.workers![0].gpuCount).toBe(2);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/endpoints/ep-1');
    expect(String(url)).toContain('includeWorkers=true');
  });

  it('listEndpoints returns array with includeWorkers', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: 'ep-1', gpuCount: 2, workers: [{ id: 'w-1', desiredStatus: 'RUNNING' }] },
        ]),
        { status: 200 }
      )
    );

    const client = new RunpodApiClient('test-api-key');
    const list = await client.listEndpoints({ includeWorkers: true });
    expect(list).toHaveLength(1);
    expect(list[0].workers).toHaveLength(1);
  });

  it('deleteTemplate succeeds on 204', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = new RunpodApiClient('test-api-key');
    await expect(client.deleteTemplate('tpl-del')).resolves.toBeUndefined();
  });
});
