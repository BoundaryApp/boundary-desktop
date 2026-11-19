import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>;
    constructor(opts: { defaults?: Record<string, unknown> }) {
      this.data = structuredClone(opts.defaults ?? {});
    }
    get(key: string): unknown {
      return this.data[key];
    }
    set(key: string, value: unknown): void {
      this.data[key] = value;
    }
  },
}));

import {
  lookupReportedParallel,
  resetWorkloadLimitsForTests,
  resolveRepliesAtOnce,
  serverOrigin,
  setRepliesAtOnceOverride,
} from '../workloadLimits';

function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (!(url in routes)) return new Response('{"error":"Unexpected endpoint"}', { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const LM = { endpointUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen/qwen3.6-35b-a3b' };

describe('workloadLimits', () => {
  afterEach(() => {
    resetWorkloadLimitsForTests();
    setRepliesAtOnceOverride('http://127.0.0.1:1234', null);
  });

  it('keys servers by origin', () => {
    expect(serverOrigin('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234');
    expect(serverOrigin('http://localhost:11434/v1/')).toBe('http://localhost:11434');
  });

  it("reads LM Studio's parallel for the selected model's loaded instance", async () => {
    const { impl } = fakeFetch({
      'http://127.0.0.1:1234/api/v1/models': {
        models: [
          { key: 'text-embedding-nomic', loaded_instances: [{ id: 'text-embedding-nomic', config: { context_length: 2048 } }] },
          { key: 'qwen/qwen3.6-35b-a3b', loaded_instances: [{ id: 'qwen/qwen3.6-35b-a3b', config: { parallel: 4 } }] },
        ],
      },
    });
    expect(await lookupReportedParallel(LM, impl)).toBe(4);
  });

  it('reports nothing for an LM Studio model that is not loaded', async () => {
    const { impl, calls } = fakeFetch({
      'http://127.0.0.1:1234/api/v1/models': { models: [{ key: 'qwen/qwen3.6-35b-a3b', loaded_instances: [] }] },
    });
    expect(await lookupReportedParallel(LM, impl)).toBeUndefined();
    expect(calls).toEqual(['http://127.0.0.1:1234/api/v1/models']);
  });

  it("reads llama.cpp's total_slots from /props", async () => {
    const { impl } = fakeFetch({ 'http://127.0.0.1:8081/props': { total_slots: 4 } });
    expect(await lookupReportedParallel({ endpointUrl: 'http://127.0.0.1:8081/v1', modelId: 'm' }, impl)).toBe(4);
  });

  it('reports nothing for Ollama, which has no such field', async () => {
    const { impl } = fakeFetch({ 'http://127.0.0.1:11434/api/ps': { models: [] } });
    expect(await lookupReportedParallel({ endpointUrl: 'http://127.0.0.1:11434/v1', modelId: 'llama3' }, impl)).toBeUndefined();
  });

  it('uses the setting over the reported count, and 1 when neither is there', async () => {
    const { impl } = fakeFetch({
      'http://127.0.0.1:1234/api/v1/models': {
        models: [{ key: LM.modelId, loaded_instances: [{ id: LM.modelId, config: { parallel: 4 } }] }],
      },
    });
    expect(await resolveRepliesAtOnce(LM, impl)).toEqual({ server: 'http://127.0.0.1:1234', limit: 4, reported: 4 });
    setRepliesAtOnceOverride('http://127.0.0.1:1234', 2);
    expect(await resolveRepliesAtOnce(LM, impl)).toEqual({
      server: 'http://127.0.0.1:1234',
      limit: 2,
      reported: 4,
      override: 2,
    });
    const none = fakeFetch({});
    expect(await resolveRepliesAtOnce({ endpointUrl: 'http://127.0.0.1:11434/v1', modelId: 'x' }, none.impl)).toEqual({
      server: 'http://127.0.0.1:11434',
      limit: 1,
    });
  });

  it('asks the server again only after a minute', async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = fakeFetch({});
      const ollama = { endpointUrl: 'http://127.0.0.1:11434/v1', modelId: 'x' };
      await resolveRepliesAtOnce(ollama, impl);
      await resolveRepliesAtOnce(ollama, impl);
      expect(calls).toHaveLength(2);
      vi.advanceTimersByTime(61_000);
      await resolveRepliesAtOnce(ollama, impl);
      expect(calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
