import { describe, expect, it, vi } from 'vitest';
import { buildHermesConfigGetExec, parseHermesConfigGet } from '../hermesConfigSetExec';
import {
  applyHermesProfileLimits,
  HERMES_MAX_TOKENS_DEFAULT,
  hermesMaxTokensFor,
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

describe('hermes config get', () => {
  it('reads through a shell so an unset key is not a failure', () => {
    expect(buildHermesConfigGetExec('orchestrator', 'model.max_tokens').args).toEqual([
      'exec', '-T', 'hermes', 'sh', '-c', '"$@" || true', 'sh',
      'hermes', '-p', 'orchestrator', 'config', 'get', 'model.max_tokens',
    ]);
    expect(buildHermesConfigGetExec('', 'model.max_tokens').args).not.toContain('-p');
  });

  it('tells a value, an unset key and an error apart', () => {
    expect(parseHermesConfigGet('1024\n')).toBe('1024');
    expect(parseHermesConfigGet('Config key not set: model.max_tokens\n')).toBeNull();
    expect(parseHermesConfigGet("Error: Profile 'x' does not exist.")).toBeUndefined();
    expect(parseHermesConfigGet('')).toBeUndefined();
  });
});

describe('applyHermesProfileLimits', () => {
  it('writes max_tokens only to a profile that has none', async () => {
    const compose = vi.fn(async (args: string[]) => ({
      stdout: args.includes('get') ? 'Config key not set: model.max_tokens' : '',
      stderr: '',
    }));
    await applyHermesProfileLimits(compose, 'researcher', {
      staleTimeoutS: 300,
      maxTokens: 16384,
      contextLength: 65536,
    });
    const sets = compose.mock.calls
      .map(([args]) => args)
      .filter((args) => args.includes('set'))
      .map((args) => args.slice(-2));
    expect(sets).toEqual([
      ['agent.local_stream_stale_timeout', '300'],
      ['model.max_tokens', '16384'],
      ['model.context_length', '65536'],
    ]);
  });

  it('keeps an existing max_tokens and writes nothing on unreadable output', async () => {
    for (const stdout of ['1024', 'Error: no such profile']) {
      const compose = vi.fn(async (args: string[]) => ({
        stdout: args.includes('get') ? stdout : '',
        stderr: '',
      }));
      await applyHermesProfileLimits(compose, 'browser', { staleTimeoutS: 180, maxTokens: 16384 });
      const keys = compose.mock.calls.filter(([a]) => a.includes('set')).map(([a]) => a.at(-2));
      expect(keys).toEqual(['agent.local_stream_stale_timeout']);
    }
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
