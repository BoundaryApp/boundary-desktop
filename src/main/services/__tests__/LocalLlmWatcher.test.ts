import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredLocalLlm, LocalLlmChangedPayload } from '../../../shared/types/onboarding';
import {
  clearStaleLocalLlmDismissals,
  dismissLocalLlmOrigin,
  __testing as dismissTesting,
} from '../onboarding/LocalLlmDismissStore';
import {
  computeRisingEdges,
  createLocalLlmWatcher,
} from '../onboarding/LocalLlmWatcher';

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

const ollamaNewModel: DiscoveredLocalLlm = {
  runtime: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: [
    { id: 'llama3:latest', loaded: true },
    { id: 'mistral:7b', loaded: true },
  ],
};

describe('computeRisingEdges', () => {
  it('treats a newly present origin as a rising edge', () => {
    expect(computeRisingEdges([], [ollamaLoaded])).toEqual([ollamaLoaded]);
  });

  it('treats a newly loaded model as a rising edge', () => {
    expect(computeRisingEdges([ollamaLoaded], [ollamaNewModel])).toEqual([ollamaNewModel]);
  });

  it('does not rise when the snapshot is unchanged', () => {
    expect(computeRisingEdges([ollamaLoaded], [ollamaLoaded])).toEqual([]);
  });
});

describe('createLocalLlmWatcher', () => {
  afterEach(() => {
    dismissTesting.reset();
    vi.restoreAllMocks();
  });

  function setup(options?: {
    currentEndpointUrl?: string;
    discoverImpl?: () => Promise<{ success: boolean; endpoints: DiscoveredLocalLlm[] }>;
  }) {
    const broadcasts: LocalLlmChangedPayload[] = [];
    let endpoints: DiscoveredLocalLlm[] = [];
    const discover =
      options?.discoverImpl ??
      (async () => ({
        success: true,
        endpoints,
      }));
    const watcher = createLocalLlmWatcher({
      discover,
      getCurrentEndpointUrl: () => options?.currentEndpointUrl,
      clearStaleDismissals: clearStaleLocalLlmDismissals,
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

  it('seeds the first poll without toast candidates', async () => {
    const { watcher, broadcasts, setEndpoints } = setup();
    setEndpoints([ollamaLoaded]);

    const first = await watcher.poll();
    expect(first?.toastCandidates).toEqual([]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].endpoints).toEqual([ollamaLoaded]);
  });

  it('toasts when a local LLM appears after the baseline', async () => {
    const { watcher, broadcasts, setEndpoints } = setup();
    setEndpoints([]);
    await watcher.poll();

    setEndpoints([ollamaLoaded]);
    const second = await watcher.poll();
    expect(second?.toastCandidates).toEqual([ollamaLoaded]);
    expect(broadcasts).toHaveLength(2);
  });

  it('does not toast when the saved endpoint already matches', async () => {
    const { watcher, setEndpoints } = setup({
      currentEndpointUrl: 'http://127.0.0.1:11434/v1',
    });
    setEndpoints([]);
    await watcher.poll();
    setEndpoints([ollamaLoaded]);
    const second = await watcher.poll();
    expect(second?.toastCandidates).toEqual([]);
  });

  it('does not toast when no model is loaded', async () => {
    const { watcher, setEndpoints } = setup();
    setEndpoints([]);
    await watcher.poll();
    setEndpoints([ollamaUnloaded]);
    const second = await watcher.poll();
    expect(second?.endpoints).toEqual([ollamaUnloaded]);
    expect(second?.toastCandidates).toEqual([]);
  });

  it('skips dismissed origins until they disappear', async () => {
    const { watcher, setEndpoints } = setup();
    setEndpoints([]);
    await watcher.poll();

    dismissLocalLlmOrigin('ollama', 'http://127.0.0.1:11434/v1');
    setEndpoints([ollamaLoaded]);
    const whileDismissed = await watcher.poll();
    expect(whileDismissed?.toastCandidates).toEqual([]);

    setEndpoints([]);
    await watcher.poll();

    setEndpoints([ollamaLoaded]);
    const afterGone = await watcher.poll();
    expect(afterGone?.toastCandidates).toEqual([ollamaLoaded]);
  });

  it('returns null for an unchanged snapshot after seeding', async () => {
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
