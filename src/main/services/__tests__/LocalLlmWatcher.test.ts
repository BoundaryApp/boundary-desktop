import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredLocalLlm, LocalLlmChangedPayload } from '../../../shared/types/onboarding';
import { createLocalLlmWatcher } from '../onboarding/LocalLlmWatcher';

const ollamaLoaded: DiscoveredLocalLlm = {
  runtime: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'llama3:latest', loaded: true }],
};

const ollamaUnloaded: DiscoveredLocalLlm = {
  runtime: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [{ id: 'llama3:latest', loaded: false }],
};

describe('createLocalLlmWatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup() {
    const broadcasts: LocalLlmChangedPayload[] = [];
    let endpoints: DiscoveredLocalLlm[] = [];
    const watcher = createLocalLlmWatcher({
      discover: async () => ({ success: true, endpoints }),
      broadcast: (payload) => {
        broadcasts.push(payload);
      },
    });
    return {
      watcher,
      broadcasts,
      setEndpoints: (next: DiscoveredLocalLlm[]) => {
        endpoints = next;
      },
    };
  }

  it('broadcasts the endpoints found on the first poll', async () => {
    const { watcher, broadcasts, setEndpoints } = setup();
    setEndpoints([ollamaLoaded]);

    const first = await watcher.poll();
    expect(first).toEqual({ endpoints: [ollamaLoaded] });
    expect(broadcasts).toEqual([{ endpoints: [ollamaLoaded] }]);
  });

  it('broadcasts when the snapshot changes', async () => {
    const { watcher, broadcasts, setEndpoints } = setup();
    setEndpoints([ollamaUnloaded]);
    await watcher.poll();

    setEndpoints([ollamaLoaded]);
    const second = await watcher.poll();
    expect(second?.endpoints).toEqual([ollamaLoaded]);
    expect(broadcasts).toHaveLength(2);
  });

  it('returns null for an unchanged snapshot', async () => {
    const { watcher, broadcasts, setEndpoints } = setup();
    setEndpoints([ollamaLoaded]);
    await watcher.poll();
    const second = await watcher.poll();
    expect(second).toBeNull();
    expect(broadcasts).toHaveLength(1);
  });

  it('does not call chat completions', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not fetch');
    });
    vi.stubGlobal('fetch', fetchImpl);
    const { watcher, setEndpoints } = setup();
    setEndpoints([]);
    await watcher.poll();
    setEndpoints([ollamaLoaded]);
    await watcher.poll();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
