import { describe, expect, it, vi, afterEach } from 'vitest';
import { triggerScaleWarmup } from '../infrastructure/stackWarmupProbe';

describe('triggerScaleWarmup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs minimal chat completion to the OpenAI base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await triggerScaleWarmup(
      'https://api.runpod.ai/v2/ep/openai/v1',
      'rp_key',
      'meta-llama/Llama-3.3-70B-Instruct'
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.runpod.ai/v2/ep/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rp_key');
    const body = JSON.parse(String(init.body));
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
  });
});
