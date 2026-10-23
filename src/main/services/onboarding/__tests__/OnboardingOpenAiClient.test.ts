import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendOnboardingTestMessage } from '../OnboardingOpenAiClient';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
} from '../OpenAiOnboardingStore';
import { OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';

describe('sendOnboardingTestMessage', () => {
  afterEach(() => {
    clearOpenAiConfig();
    vi.unstubAllGlobals();
  });

  it('hits the requested slot endpoint instead of the app-default connection', async () => {
    saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ready' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendOnboardingTestMessage('Reply with the word ready.', 'openrouter');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('openrouter.ai');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('11434');
  });
});
