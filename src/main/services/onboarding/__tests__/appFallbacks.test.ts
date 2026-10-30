import { beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';
import {
  clearLlmSlot,
  clearOpenAiConfig,
  getAppFallbacks,
  getOpenAiOnboardingStatus,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  setAppFallbacks,
} from '../OpenAiOnboardingStore';

describe('app default fallbacks', () => {
  beforeEach(async () => {
    await clearOpenAiConfig();
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
  });

  it('refuses a provider that is not connected', async () => {
    const result = await setAppFallbacks([{ slot: 'openrouter' }]);
    expect(result.success).toBe(false);
    expect(getAppFallbacks()).toEqual([]);
  });

  it('keeps each slot and model once, never the app default itself, and blank models blank', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    const result = await setAppFallbacks([
      { slot: 'local' },
      { slot: 'openrouter' },
      { slot: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      { slot: 'openrouter', modelId: ' google/gemini-3-flash ' },
    ]);
    expect(result.success).toBe(true);
    expect(getAppFallbacks()).toEqual([
      { slot: 'openrouter' },
      { slot: 'openrouter', modelId: 'google/gemini-3-flash' },
    ]);
    expect((await getOpenAiOnboardingStatus()).appFallbacks).toEqual(getAppFallbacks());
  });

  it('keeps a fallback whose provider is disconnected later, so it shows as stale', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    await setAppFallbacks([{ slot: 'openrouter' }]);
    await clearLlmSlot('openrouter');
    expect(getAppFallbacks()).toEqual([{ slot: 'openrouter' }]);
  });

  it('keeps shared models in order, once each, and refuses a malformed one', async () => {
    const peer = { circleId: 'c'.repeat(64), providerId: 'a'.repeat(64) };
    const result = await setAppFallbacks([
      { slot: 'peer', modelId: ' qwen3-8b ', peer },
      { slot: 'peer', modelId: 'qwen3-8b', peer },
      { slot: 'peer', modelId: 'llama', peer: { ...peer, providerId: 'b'.repeat(64) } },
    ]);
    expect(result.success).toBe(true);
    expect(getAppFallbacks()).toEqual([
      { slot: 'peer', modelId: 'qwen3-8b', peer },
      { slot: 'peer', modelId: 'llama', peer: { ...peer, providerId: 'b'.repeat(64) } },
    ]);

    for (const bad of [
      { slot: 'peer' as const, modelId: 'm' },
      { slot: 'peer' as const, modelId: '', peer },
      { slot: 'peer' as const, modelId: 'm', peer: { circleId: 'nope', providerId: peer.providerId } },
    ]) {
      expect((await setAppFallbacks([bad])).success).toBe(false);
    }
    expect(getAppFallbacks()).toHaveLength(2);
  });
});
