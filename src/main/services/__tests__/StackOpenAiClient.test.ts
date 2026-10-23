import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(() => ({ secrets: {} })),
    set: vi.fn(),
  })),
}));

vi.mock('../infrastructure/instanceResolver', () => ({
  getInstanceWithRecipe: vi.fn(),
}));

vi.mock('../infrastructure/StackSecretsStore', () => ({
  getSecret: vi.fn(),
}));

import {
  parseSseChatLines,
  startChatCompletionStream,
} from '../infrastructure/StackOpenAiClient';
import * as instanceResolver from '../infrastructure/instanceResolver';
import * as secretsStore from '../infrastructure/StackSecretsStore';

const runpodRecipe = {
  id: 'runpod-vllm-llama',
  modelId: 'meta-llama/Llama-3.3-70B-Instruct',
  provider: 'runpod' as const,
  displayName: 'RunPod',
  driver: { kind: 'terraform' as const, config: {} },
  secrets: [],
  readiness: {
    probe: 'openai-models' as const,
    warmupPost: true,
    warmingTimeoutMs: 1,
    pollIntervalMs: { warming: 1, active: 1, degraded: 1 },
  },
  outputs: { authSecret: 'runpod_api_key', openaiBaseUrlKey: 'openai_base_url' },
};

function mockResolvedInstance(overrides: Record<string, unknown> = {}) {
  return {
    instance: {
      id: 'inst-1',
      stackTypeId: 'runpod-vllm-llama',
      displayName: 'Test',
      phase: 'active',
      vars: {},
      outputs: {
        openai_base_url: 'https://api.runpod.ai/v2/ep/openai/v1',
        model_id: 'meta-llama/Llama-3.3-70B-Instruct',
      },
      driftDetected: false,
      healthStatus: 'healthy',
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    },
    recipe: runpodRecipe,
  };
}

describe('parseSseChatLines', () => {
  it('extracts delta content from SSE data lines', () => {
    const deltas: string[] = [];
    const input =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n' +
      'data: [DONE]\n\n';
    const { remainder, done } = parseSseChatLines(input, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hi', ' there']);
    expect(done).toBe(true);
    expect(remainder).toBe('');
  });

  it('keeps incomplete line in remainder', () => {
    const deltas: string[] = [];
    const { remainder, done } = parseSseChatLines(
      'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"cho',
      (d) => deltas.push(d)
    );
    expect(deltas).toEqual(['A']);
    expect(done).toBe(false);
    expect(remainder).toBe('data: {"cho');
  });
});

describe('startChatCompletionStream', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(instanceResolver.getInstanceWithRecipe).mockResolvedValue(
      mockResolvedInstance() as Awaited<ReturnType<typeof instanceResolver.getInstanceWithRecipe>>
    );
    vi.mocked(secretsStore.getSecret).mockResolvedValue('test-api-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function sseResponse(body: string): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('streams deltas and ends on success', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
      )
    );

    const deltas: string[] = [];
    let endReason: string | undefined;
    await startChatCompletionStream(
      'inst-1',
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
      {
        onDelta: (d) => deltas.push(d),
        onEnd: (r) => {
          endReason = r;
        },
        onError: (e) => {
          throw new Error(e);
        },
      }
    );

    expect(deltas).toEqual(['Hello']);
    expect(endReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.runpod.ai/v2/ep/openai/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      })
    );
  });

  it('errors when openai_base_url is missing', async () => {
    vi.mocked(instanceResolver.getInstanceWithRecipe).mockResolvedValue(
      mockResolvedInstance({ outputs: {} }) as Awaited<
        ReturnType<typeof instanceResolver.getInstanceWithRecipe>
      >
    );

    let err = '';
    await startChatCompletionStream(
      'inst-1',
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
      {
        onDelta: () => {},
        onEnd: () => {},
        onError: (e) => {
          err = e;
        },
      }
    );

    expect(err).toContain('OpenAI base URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors when API key is missing', async () => {
    vi.mocked(secretsStore.getSecret).mockResolvedValue(null);

    let err = '';
    await startChatCompletionStream(
      'inst-1',
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
      {
        onDelta: () => {},
        onEnd: () => {},
        onError: (e) => {
          err = e;
        },
      }
    );

    expect(err).toContain('runpod_api_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports HTTP errors', async () => {
    fetchMock.mockResolvedValue(
      new Response('endpoint not ready', { status: 503, statusText: 'Service Unavailable' })
    );

    let err = '';
    await startChatCompletionStream(
      'inst-1',
      [{ role: 'user', content: 'Hi' }],
      new AbortController().signal,
      {
        onDelta: () => {},
        onEnd: () => {},
        onError: (e) => {
          err = e;
        },
      }
    );

    expect(err).toContain('HTTP 503');
  });

  it('ends without error when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

    let ended = false;
    let errored = false;
    await startChatCompletionStream(
      'inst-1',
      [{ role: 'user', content: 'Hi' }],
      controller.signal,
      {
        onDelta: () => {},
        onEnd: () => {
          ended = true;
        },
        onError: () => {
          errored = true;
        },
      }
    );

    expect(ended).toBe(true);
    expect(errored).toBe(false);
  });
});
