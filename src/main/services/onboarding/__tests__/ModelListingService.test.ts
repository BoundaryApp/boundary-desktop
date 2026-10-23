import { afterEach, describe, expect, it, vi } from 'vitest';
import { listEndpointModels } from '../ModelListingService';
import { clearOpenRouterAaCache } from '../openrouterAaBenchmarks';

function modelsPayload(data: unknown[]) {
  return {
    ok: true,
    text: async () => JSON.stringify({ data }),
  };
}

function aaPayload(data: unknown[]) {
  return {
    ok: true,
    text: async () => JSON.stringify({ data }),
  };
}

describe('ModelListingService', () => {
  afterEach(() => {
    clearOpenRouterAaCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses OpenAI-compatible model listings', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/benchmarks')) {
        return aaPayload([]);
      }
      return modelsPayload([
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'anthropic/claude-sonnet-4.6' },
      ]);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await listEndpointModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      authScheme: 'bearer',
    });

    expect(result.success).toBe(true);
    expect(result.models).toEqual([
      { id: 'anthropic/claude-sonnet-4.6', displayName: 'anthropic/claude-sonnet-4.6' },
      { id: 'openai/gpt-4o', displayName: 'GPT-4o' },
    ]);
  });

  it('parses OpenRouter-style pricing and context metadata', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/benchmarks')) {
        return aaPayload([]);
      }
      return modelsPayload([
        {
          id: 'google/gemini-flash',
          name: 'Gemini Flash',
          context_length: 1_048_576,
          pricing: {
            prompt: '0.00000075',
            completion: '0.00000375',
          },
        },
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          description: 'Multimodal flagship',
        },
        {
          id: 'meta/llama-free',
          name: 'Llama Free',
          context_length: 8192,
          pricing: {
            prompt: '0',
            completion: '0',
          },
        },
      ]);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await listEndpointModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      authScheme: 'bearer',
    });

    expect(result.success).toBe(true);
    expect(result.models).toEqual([
      {
        id: 'google/gemini-flash',
        displayName: 'Gemini Flash',
        contextLength: 1_048_576,
        pricing: {
          promptPerToken: '0.00000075',
          completionPerToken: '0.00000375',
        },
      },
      {
        id: 'meta/llama-free',
        displayName: 'Llama Free',
        contextLength: 8192,
        pricing: {
          promptPerToken: '0',
          completionPerToken: '0',
        },
      },
      {
        id: 'openai/gpt-4o',
        displayName: 'GPT-4o',
        description: 'Multimodal flagship',
      },
    ]);
  });

  it('ignores empty pricing objects and non-positive context lengths', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      modelsPayload([
        {
          id: 'vendor/model-a',
          name: 'Model A',
          context_length: 0,
          pricing: {},
        },
      ])
    );

    vi.stubGlobal('fetch', fetchMock);

    const result = await listEndpointModels({
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-test',
    });

    expect(result.success).toBe(true);
    expect(result.models).toEqual([{ id: 'vendor/model-a', displayName: 'Model A' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('joins Artificial Analysis scores for OpenRouter endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/benchmarks')) {
        return aaPayload([
          {
            source: 'artificial-analysis',
            model_permaslug: 'openai/gpt-4o',
            intelligence_index: 71.2,
            coding_index: 65.8,
          },
        ]);
      }
      return modelsPayload([
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
        { id: 'openai/gpt-4o:free', name: 'GPT-4o Free' },
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
      ]);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await listEndpointModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      authScheme: 'bearer',
      provider: 'openrouter',
    });

    expect(result.success).toBe(true);
    expect(result.models.find((m) => m.id === 'openai/gpt-4o')?.aa).toEqual({
      intelligence: 71.2,
      coding: 65.8,
    });
    expect(result.models.find((m) => m.id === 'openai/gpt-4o:free')?.aa).toEqual({
      intelligence: 71.2,
      coding: 65.8,
    });
    expect(result.models.find((m) => m.id === 'anthropic/claude-sonnet-4')?.aa).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not call benchmarks for non-OpenRouter hosts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      modelsPayload([{ id: 'vendor/model-a', name: 'Model A' }])
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await listEndpointModels({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      provider: 'manual',
    });

    expect(result.success).toBe(true);
    expect(result.models[0]?.aa).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns models when benchmarks fail', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('/benchmarks')) {
        return { ok: false, status: 401, text: async () => 'unauthorized' };
      }
      return modelsPayload([{ id: 'openai/gpt-4o', name: 'GPT-4o' }]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await listEndpointModels({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      provider: 'openrouter',
    });

    expect(result.success).toBe(true);
    expect(result.models).toEqual([{ id: 'openai/gpt-4o', displayName: 'GPT-4o' }]);
  });
});
