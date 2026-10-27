import { describe, expect, it, vi } from 'vitest';
import {
  HERMES_MAX_TOKENS_DEFAULT,
  hermesMaxTokensFor,
  hermesProfileLimitSets,
  lookupModelContextLength,
} from '../hermesProfileLimits';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('hermesMaxTokensFor', () => {
  it('defaults like the stack, honours 0, and ignores junk', () => {
    expect(hermesMaxTokensFor(undefined)).toBe(HERMES_MAX_TOKENS_DEFAULT);
    expect(hermesMaxTokensFor(' 8192 ')).toBe(8192);
    expect(hermesMaxTokensFor('0')).toBe(0);
    expect(hermesMaxTokensFor('lots')).toBe(HERMES_MAX_TOKENS_DEFAULT);
    expect(hermesMaxTokensFor('-5')).toBe(HERMES_MAX_TOKENS_DEFAULT);
  });
});

describe('hermesProfileLimitSets', () => {
  it('sets the stale timeout and context length, and max_tokens only where a profile has none', () => {
    expect(hermesProfileLimitSets({ staleTimeoutS: 300, maxTokens: 16384, contextLength: 65536 })).toEqual({
      set: [
        ['agent.local_stream_stale_timeout', '300'],
        ['model.context_length', '65536'],
      ],
      setIfUnset: [['model.max_tokens', '16384']],
    });
  });

  it('writes no context length when unknown and no max_tokens when it is 0', () => {
    expect(hermesProfileLimitSets({ staleTimeoutS: 180, maxTokens: 0 })).toEqual({
      set: [['agent.local_stream_stale_timeout', '180']],
      setIfUnset: [],
    });
  });
});

describe('lookupModelContextLength', () => {
  const llm = { endpointUrl: 'http://127.0.0.1:1234/v1/', apiKey: 'lm', modelId: 'qwen/qwen3.6-35b-a3b' };

  it("reads LM Studio's loaded context length", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/api/v0/models/')
        ? json({ id: llm.modelId, state: 'loaded', max_context_length: 262144, loaded_context_length: 32768 })
        : json({ data: [] })
    );
    expect(await lookupModelContextLength(llm, fetchImpl as unknown as typeof fetch)).toBe(32768);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:1234/api/v0/models/qwen/qwen3.6-35b-a3b');
  });

  it('gives no answer for an LM Studio model that is not loaded', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ id: llm.modelId, state: 'not-loaded', max_context_length: 262144 })
    );
    expect(await lookupModelContextLength(llm, fetchImpl as unknown as typeof fetch)).toBeUndefined();
  });

  it('falls back to context_length on the model list', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/v1/models')
        ? json({ data: [{ id: 'other' }, { id: 'anthropic/claude-sonnet-4', context_length: 200000 }] })
        : json({ detail: 'nope' }, 404)
    );
    const result = await lookupModelContextLength(
      { endpointUrl: 'https://openrouter.ai/api/v1', modelId: 'anthropic/claude-sonnet-4' },
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toBe(200000);
  });

  it('gives no answer when the server is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await lookupModelContextLength(llm, fetchImpl as unknown as typeof fetch)).toBeUndefined();
  });
});
