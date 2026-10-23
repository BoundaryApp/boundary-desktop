import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverLocalLlms } from '../onboarding/LocalLlmDiscovery';

type JsonResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

function jsonResponse(body: unknown, ok = true): JsonResponse {
  return {
    ok,
    json: async () => body,
  };
}

function mockFetchByUrl(
  handlers: Record<string, () => Promise<JsonResponse> | JsonResponse | Promise<never>>
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = handlers[url];
    if (!handler) {
      throw new TypeError(`fetch failed: ${url}`);
    }
    return handler() as Promise<Response>;
  });
}

describe('discoverLocalLlms', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty endpoints when nothing is listening', async () => {
    const fetchImpl = mockFetchByUrl({});
    const result = await discoverLocalLlms({ fetchImpl });
    expect(result.success).toBe(true);
    expect(result.endpoints).toEqual([]);
    expect(String(fetchImpl.mock.calls)).not.toContain('chat/completions');
  });

  it('discovers Ollama with downloaded and loaded models', async () => {
    const fetchImpl = mockFetchByUrl({
      'http://127.0.0.1:11434/api/tags': () =>
        jsonResponse({
          models: [{ name: 'llama3:latest' }, { name: 'mistral:7b' }],
        }),
      'http://127.0.0.1:11434/api/ps': () =>
        jsonResponse({
          models: [{ name: 'llama3:latest' }],
        }),
    });

    const result = await discoverLocalLlms({ fetchImpl });

    expect(result).toEqual({
      success: true,
      endpoints: [
        {
          runtime: 'ollama',
          displayName: 'Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [
            { id: 'llama3:latest', loaded: true },
            { id: 'mistral:7b', loaded: false },
          ],
        },
      ],
    });
  });

  it('treats Ollama as present even when no model is loaded', async () => {
    const fetchImpl = mockFetchByUrl({
      'http://127.0.0.1:11434/api/tags': () =>
        jsonResponse({
          models: [{ name: 'llama3:latest' }],
        }),
      'http://127.0.0.1:11434/api/ps': () => jsonResponse({ models: [] }),
    });

    const result = await discoverLocalLlms({ fetchImpl });
    expect(result.endpoints[0]?.models).toEqual([{ id: 'llama3:latest', loaded: false }]);
  });

  it('discovers LM Studio via OpenAI /v1/models', async () => {
    const fetchImpl = mockFetchByUrl({
      'http://127.0.0.1:1234/v1/models': () =>
        jsonResponse({
          object: 'list',
          data: [{ id: 'qwen2.5-7b' }],
        }),
    });

    const result = await discoverLocalLlms({ fetchImpl });
    expect(result.endpoints).toEqual([
      {
        runtime: 'lmstudio',
        displayName: 'LM Studio',
        baseUrl: 'http://127.0.0.1:1234/v1',
        models: [{ id: 'qwen2.5-7b', loaded: true }],
      },
    ]);
  });

  it('ignores a non-Ollama process on the Ollama port', async () => {
    const fetchImpl = mockFetchByUrl({
      'http://127.0.0.1:11434/api/tags': () => jsonResponse({ status: 'ok' }),
      'http://127.0.0.1:1234/v1/models': () => jsonResponse({ error: 'not openai' }),
    });

    const result = await discoverLocalLlms({ fetchImpl });
    expect(result.endpoints).toEqual([]);
  });

  it('treats probe timeouts as absent', async () => {
    const fetchImpl = mockFetchByUrl({
      'http://127.0.0.1:11434/api/tags': async () => {
        throw new Error('The operation was aborted.');
      },
    });

    const result = await discoverLocalLlms({ fetchImpl });
    expect(result.success).toBe(true);
    expect(result.endpoints).toEqual([]);
  });

  it('never posts chat completions during discovery', async () => {
    const fetchImpl = mockFetchByUrl({
      'http://127.0.0.1:11434/api/tags': () => jsonResponse({ models: [] }),
      'http://127.0.0.1:11434/api/ps': () => jsonResponse({ models: [] }),
      'http://127.0.0.1:1234/v1/models': () => jsonResponse({ data: [] }),
    });

    await discoverLocalLlms({ fetchImpl });
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls.every((url) => !url.includes('chat/completions'))).toBe(true);
    expect(urls).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:11434/api/tags',
        'http://127.0.0.1:11434/api/ps',
        'http://127.0.0.1:1234/v1/models',
      ])
    );
  });
});
