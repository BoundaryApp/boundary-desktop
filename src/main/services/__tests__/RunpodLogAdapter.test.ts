import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchRunpodLogTail, isUsefulApplyLogLine } from '../infrastructure/RunpodLogAdapter';

describe('fetchRunpodLogTail', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('returns synthetic lines from worker status when REST logs unavailable', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const result = await fetchRunpodLogTail('key', 'ep-1', {
      workers: [{ id: 'w1', lastStatusChange: 'Downloading model' }],
      healthMessage: 'HTTP 503',
      limit: 50,
    });

    expect(result.source).toBe('synthetic');
    expect(result.lines.some((l) => l.includes('Downloading model'))).toBe(true);
    expect(result.lines.some((l) => l.includes('HTTP 503'))).toBe(true);
  });

  it('filters terraform plan lines from apply task tail', () => {
    expect(
      isUsefulApplyLogLine(
        '[apply] [2026-05-25T17:07:40.447Z] [INFO] Terraform will perform the following actions:'
      )
    ).toBe(false);
    expect(
      isUsefulApplyLogLine('[apply] [2026-05-25T17:07:40.447Z] [INFO]   + "US-CA-2",')
    ).toBe(false);
    expect(
      isUsefulApplyLogLine(
        '[apply] [2026-05-25T17:07:41.538Z] [INFO] openai_base_url = "https://api.runpod.ai/v2/x/openai/v1"'
      )
    ).toBe(true);
    expect(
      isUsefulApplyLogLine(
        '[apply] [2026-05-25T17:07:41.499Z] [INFO] runpod_endpoint.vllm: Creation complete after 0s'
      )
    ).toBe(true);
  });

  it('redacts tokens in API log lines', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ lines: ['HF_TOKEN=secret123'] }), { status: 200 })
    );
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const result = await fetchRunpodLogTail('key', 'ep-1', { limit: 10 });
    if (result.source === 'api') {
      expect(result.lines[0]).toContain('[REDACTED]');
      expect(result.lines[0]).not.toContain('secret123');
    }
  });
});
