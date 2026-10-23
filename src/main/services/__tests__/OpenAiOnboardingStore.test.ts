import { safeStorage } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLlmSlot,
  clearOpenAiConfig,
  getAppDefaultSlot,
  getLlmConnection,
  getOpenAiApiKey,
  getOpenAiOnboardingStatus,
  getSlotConnectionMaterial,
  getStoredLlmConnectionMaterial,
  hasPendingOAuthModelSelection,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  saveOAuthCredentials,
  saveOpenAiConfig,
  saveProviderEndpoint,
  setAppDefault,
  updateLlmModel,
  writeV1DocumentForTesting,
  __testing,
} from '../onboarding/OpenAiOnboardingStore';
import {
  LOCAL_LLM_CAPABILITIES,
  MANUAL_LLM_CAPABILITIES,
  OAUTH_LLM_CAPABILITIES,
} from '../../../shared/llmConnectionDefaults';

describe('OpenAiOnboardingStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearOpenAiConfig();
  });

  it('is unconfigured by default', () => {
    expect(getOpenAiOnboardingStatus()).toEqual({
      configured: false,
      encryptionAvailable: true,
      appDefault: null,
      slots: {},
    });
  });

  it('saves a remote manual connection into infrastructure without clobbering later local', () => {
    const result = saveLlmConnection({
      endpointUrl: 'https://example.test/v1/',
      apiKey: 'sk-test-key',
      modelId: 'openai/gpt-4o',
      provider: 'manual',
      providerDisplayName: 'Custom endpoint',
      authScheme: 'bearer',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(result.success).toBe(true);
    expect(result.status?.configured).toBe(true);
    expect(result.status?.appDefault).toBe('infrastructure');
    expect(result.status?.slots.infrastructure?.endpointUrl).toBe('https://example.test/v1');
    expect(result.status?.slots.infrastructure?.modelId).toBe('openai/gpt-4o');
    expect(getOpenAiApiKey()).toBe('sk-test-key');
    expect(getLlmConnection()?.modelId).toBe('openai/gpt-4o');
  });

  it('keeps Local after OpenRouter is added and does not flip appDefault', () => {
    saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'llama3:latest',
    });
    const oauth = saveOAuthCredentials({
      providerId: 'openrouter',
      providerDisplayName: 'OpenRouter',
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-persisted',
      authScheme: 'bearer',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    expect(oauth.status?.appDefault).toBe('local');
    expect(oauth.status?.slots.local?.modelId).toBe('llama3:latest');

    const saved = saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    expect(saved.success).toBe(true);
    expect(saved.status?.appDefault).toBe('local');
    expect(saved.status?.slots.local?.modelId).toBe('llama3:latest');
    expect(saved.status?.slots.openrouter?.modelId).toBe('anthropic/claude-sonnet-4');
    expect(getLlmConnection()?.modelId).toBe('llama3:latest');
    expect(getSlotConnectionMaterial('openrouter')?.apiKey).toBe('sk-or-persisted');
  });

  it('still has both slots and appDefault after a store reload', () => {
    saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    __testing.ensureV2Document();
    const status = getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('local');
    expect(status.slots.local?.modelId).toBe('qwen3:14b');
    expect(status.slots.openrouter?.modelId).toBe('openai/gpt-4o');
  });

  it('persists OAuth credentials before model selection on the openrouter slot', () => {
    const result = saveOAuthCredentials({
      providerId: 'openrouter',
      providerDisplayName: 'OpenRouter',
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-persisted',
      authScheme: 'bearer',
      capabilities: OAUTH_LLM_CAPABILITIES,
      extraHeaders: { 'HTTP-Referer': 'https://boundary.local' },
    });

    expect(result.success).toBe(true);
    expect(result.status?.configured).toBe(false);
    expect(result.status?.appDefault).toBe('openrouter');
    expect(result.status?.slots.openrouter?.endpointUrl).toBe('https://openrouter.ai/api/v1');
    expect(result.status?.slots.openrouter?.provider).toBe('openrouter');
    expect(result.status?.slots.openrouter?.apiKey?.configured).toBe(true);
    expect(result.status?.slots.openrouter?.modelId).toBeUndefined();
    expect(hasPendingOAuthModelSelection()).toBe(true);
    expect(getStoredLlmConnectionMaterial()?.apiKey).toBe('sk-or-persisted');
    expect(getLlmConnection()).toBeNull();
  });

  it('requires modelId for manual saveOpenAiConfig', () => {
    const result = saveOpenAiConfig({
      endpointUrl: 'https://example.test/v1',
      apiKey: 'sk-test-key',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Select a model');
  });

  it('updates a selectable model on the app-default slot', () => {
    saveLlmConnection({
      endpointUrl: 'https://example.test/v1',
      apiKey: 'sk-test-key',
      modelId: 'openai/gpt-4o',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    const result = updateLlmModel('anthropic/claude-sonnet-4.6');
    expect(result.success).toBe(true);
    expect(result.status?.slots.infrastructure?.modelId).toBe('anthropic/claude-sonnet-4.6');
  });

  it('refuses setAppDefault on an empty slot', () => {
    const result = setAppDefault('openrouter');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connect that provider/i);
    expect(getAppDefaultSlot()).toBeNull();
  });

  it('disconnects the default and falls back to the other configured visible slot', () => {
    saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'llama3:latest',
    });
    saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    const result = clearLlmSlot('local');
    expect(result.success).toBe(true);
    expect(result.status?.appDefault).toBe('openrouter');
    expect(result.status?.slots.local).toBeUndefined();
    expect(getLlmConnection()?.provider).toBe('openrouter');
  });

  it('saves adopted provider endpoints into the hidden infrastructure slot', () => {
    const result = saveProviderEndpoint({
      providerId: 'baseten',
      instanceId: 'adopted:model-abc',
      endpointUrl: 'https://model-model-abc.api.baseten.co/environments/production/sync/v1',
      apiKey: 'bt-secret-key',
      modelId: 'model-abc',
      authScheme: 'api-key',
      providerDisplayName: 'Baseten',
    });

    expect(result.success).toBe(true);
    expect(result.status?.appDefault).toBe('infrastructure');
    expect(result.status?.slots.infrastructure?.modelId).toBe('model-abc');
    expect(result.status?.slots.infrastructure?.capabilities?.modelChangePolicy).toBe('fixed');
  });

  it('saves a local LLM endpoint with modelId', () => {
    const result = saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'llama3:latest',
    });

    expect(result.success).toBe(true);
    expect(result.status?.slots.local?.modelId).toBe('llama3:latest');
    expect(getOpenAiApiKey()).toBe('ollama');
  });

  it('migrates a v1 local document into the local slot as appDefault', () => {
    const encryptedApiKey = safeStorage.encryptString('ollama').toString('base64');
    writeV1DocumentForTesting({
      endpointUrl: 'http://127.0.0.1:11434/v1',
      encryptedApiKey,
      modelId: 'qwen3:14b',
      provider: 'ollama',
      providerDisplayName: 'Ollama',
      authScheme: 'bearer',
      capabilities: LOCAL_LLM_CAPABILITIES,
    });

    const status = getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('local');
    expect(status.configured).toBe(true);
    expect(status.slots.local?.modelId).toBe('qwen3:14b');
    expect(getLlmConnection()?.modelId).toBe('qwen3:14b');
  });

  it('migrates a v1 OpenRouter document into the openrouter slot', () => {
    const encryptedApiKey = safeStorage.encryptString('sk-or-legacy').toString('base64');
    writeV1DocumentForTesting({
      endpointUrl: 'https://openrouter.ai/api/v1',
      encryptedApiKey,
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    const status = getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('openrouter');
    expect(getLlmConnection()?.apiKey).toBe('sk-or-legacy');
  });

  it('migrates a v1 Baseten document into infrastructure', () => {
    const encryptedApiKey = safeStorage.encryptString('bt-legacy').toString('base64');
    writeV1DocumentForTesting({
      endpointUrl: 'https://model-abc.api.baseten.co/environments/production/sync/v1',
      encryptedApiKey,
      modelId: 'model-abc',
      provider: 'baseten',
    });

    const status = getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('infrastructure');
    expect(status.slots.infrastructure?.provider).toBe('baseten');
    expect(getLlmConnection()?.modelId).toBe('model-abc');
  });

  it('does not save API keys when OS encryption is unavailable', () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);

    const result = saveLlmConnection({
      endpointUrl: 'https://example.test/v1',
      apiKey: 'sk-test-key',
      modelId: 'openai/gpt-4o',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('OS encryption is not available');
    expect(getOpenAiApiKey()).toBeNull();
  });
});
