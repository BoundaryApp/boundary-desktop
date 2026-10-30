import { beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';
import {
  clearLlmSlot,
  clearOpenAiConfig,
  forgetSavedOpenRouterKey,
  getAppDefaultSlot,
  getOpenAiOnboardingStatus,
  getSlotApiKey,
  getSlotLlmConnection,
  reconnectSavedOpenRouterKey,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  saveOAuthCredentials,
} from '../OpenAiOnboardingStore';

const ENDPOINT = 'https://openrouter.ai/api/v1';
const MODEL = 'anthropic/claude-sonnet-4';

function connectOpenRouter() {
  return saveLlmConnection({
    endpointUrl: ENDPOINT,
    apiKey: 'sk-or-first-key',
    modelId: MODEL,
    provider: 'openrouter',
    capabilities: OAUTH_LLM_CAPABILITIES,
  });
}

describe('disconnecting OpenRouter', () => {
  beforeEach(async () => {
    await clearOpenAiConfig();
    await connectOpenRouter();
  });

  it('takes the slot out of use and keeps the key for a reconnect', async () => {
    const { status } = await clearLlmSlot('openrouter');

    expect(status?.slots.openrouter).toBeUndefined();
    expect(status?.appDefault).toBeNull();
    expect(status?.configured).toBe(false);
    expect(status?.savedOpenRouterKey?.modelId).toBe(MODEL);
    expect(status?.savedOpenRouterKey?.preview).not.toContain('first-key');
    expect(await getSlotLlmConnection('openrouter')).toBeNull();
    expect(await getSlotApiKey('openrouter')).toBeNull();
  });

  it('reconnects the same key and model, and takes the default when none is set', async () => {
    await clearLlmSlot('openrouter');
    const { status, success } = await reconnectSavedOpenRouterKey();

    expect(success).toBe(true);
    expect(status?.configured).toBe(true);
    expect(status?.savedOpenRouterKey).toBeUndefined();
    expect(getAppDefaultSlot()).toBe('openrouter');
    expect(await getSlotApiKey('openrouter')).toBe('sk-or-first-key');
    expect((await getSlotLlmConnection('openrouter'))?.modelId).toBe(MODEL);
  });

  it('leaves another default in place on reconnect', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await clearLlmSlot('openrouter');
    expect(getAppDefaultSlot()).toBe('local');

    await reconnectSavedOpenRouterKey();
    expect(getAppDefaultSlot()).toBe('local');
  });

  it('refuses a reconnect with no saved key', async () => {
    await clearLlmSlot('openrouter');
    await forgetSavedOpenRouterKey();

    const { status, success } = await reconnectSavedOpenRouterKey();
    expect(success).toBe(false);
    expect(status?.savedOpenRouterKey).toBeUndefined();
  });

  it('replaces the saved key on a new sign-in and keeps the model', async () => {
    await clearLlmSlot('openrouter');
    await saveOAuthCredentials({
      providerId: 'openrouter',
      providerDisplayName: 'OpenRouter',
      endpointUrl: ENDPOINT,
      apiKey: 'sk-or-second-key',
      authScheme: 'bearer',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    const status = await getOpenAiOnboardingStatus();
    expect(status.savedOpenRouterKey).toBeUndefined();
    expect(await getSlotApiKey('openrouter')).toBe('sk-or-second-key');
    expect((await getSlotLlmConnection('openrouter'))?.modelId).toBe(MODEL);
  });
});
