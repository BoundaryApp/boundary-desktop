import { safeStorage } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyInferenceSlot,
  clearLlmSlot,
  clearOpenAiConfig,
  ensureV2Document,
  getAppDefaultSlot,
  getAppFallbacks,
  getAppSharedModel,
  getLlmConnection,
  getOpenAiOnboardingStatus,
  getSlotApiKey,
  getSlotConnectionMaterial,
  getStoredLlmConnectionMaterial,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  saveOAuthCredentials,
  setAppDefault,
  setAppFallbacks,
  setAppSharedModel,
  updateLlmModel,
  writeV1DocumentForTesting,
} from '../onboarding/OpenAiOnboardingStore';
import {
  LOCAL_LLM_CAPABILITIES,
  MANUAL_LLM_CAPABILITIES,
  OAUTH_LLM_CAPABILITIES,
} from '../../../shared/llmConnectionDefaults';

describe('a shared model as the app default (ADR 0036)', () => {
  const shared = {
    slot: 'peer' as const,
    modelId: 'qwen3-8b',
    peer: { circleId: 'c'.repeat(64), providerId: 'b'.repeat(64) },
  };
  const openRouter = () =>
    saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearOpenAiConfig();
  });

  it('counts as configured with no provider, so setup can finish', async () => {
    expect((await setAppSharedModel(shared)).success).toBe(true);
    const status = await getOpenAiOnboardingStatus();
    expect(status).toMatchObject({ configured: true, appDefault: null, appSharedModel: shared });
    expect(await getLlmConnection()).toBeNull();
  });

  it('refuses a malformed entry', async () => {
    expect((await setAppSharedModel({ slot: 'peer', modelId: 'x' })).success).toBe(false);
    expect((await setAppSharedModel({ ...shared, modelId: ' ' })).success).toBe(false);
    expect(getAppSharedModel()).toBeNull();
  });

  it('replaces a slot default, and a slot default replaces it', async () => {
    await openRouter();
    await setAppSharedModel(shared);
    expect(getAppDefaultSlot()).toBeNull();
    expect((await setAppDefault('openrouter')).success).toBe(true);
    expect(getAppSharedModel()).toBeNull();
    expect(getAppDefaultSlot()).toBe('openrouter');
  });

  it('isn’t displaced by connecting a provider', async () => {
    await setAppSharedModel(shared);
    await openRouter();
    expect(getAppDefaultSlot()).toBeNull();
    expect(getAppSharedModel()).toEqual(shared);
  });

  it('keeps fallbacks, drops one naming the same model, and refuses it as a new one', async () => {
    await openRouter();
    await setAppFallbacks([shared]);
    await setAppSharedModel(shared);
    expect(getAppFallbacks()).toEqual([]);
    await setAppFallbacks([shared, { slot: 'openrouter' }]);
    expect(getAppFallbacks()).toEqual([{ slot: 'openrouter' }]);
  });

  it('goes with the rest when everything is cleared', async () => {
    await setAppSharedModel(shared);
    await clearOpenAiConfig();
    await setAppFallbacks([]);
    expect((await getOpenAiOnboardingStatus()).configured).toBe(false);
  });
});

describe('OpenAiOnboardingStore', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearOpenAiConfig();
  });

  it('is unconfigured by default', async () => {
    expect(await getOpenAiOnboardingStatus()).toEqual({
      configured: false,
      encryptionAvailable: true,
      appDefault: null,
      appFallbacks: [],
      slots: {},
    });
  });

  it('saves a remote manual connection into infrastructure without clobbering later local', async () => {
    const result = await saveLlmConnection({
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
    expect(await getSlotApiKey(getAppDefaultSlot())).toBe('sk-test-key');
    expect((await getLlmConnection())?.modelId).toBe('openai/gpt-4o');
  });

  it('keeps Local after OpenRouter is added and does not flip appDefault', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'llama3:latest',
    });
    const oauth = await saveOAuthCredentials({
      providerId: 'openrouter',
      providerDisplayName: 'OpenRouter',
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-persisted',
      authScheme: 'bearer',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    expect(oauth.status?.appDefault).toBe('local');
    expect(oauth.status?.slots.local?.modelId).toBe('llama3:latest');

    const saved = await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    expect(saved.success).toBe(true);
    expect(saved.status?.appDefault).toBe('local');
    expect(saved.status?.slots.local?.modelId).toBe('llama3:latest');
    expect(saved.status?.slots.openrouter?.modelId).toBe('anthropic/claude-sonnet-4');
    expect((await getLlmConnection())?.modelId).toBe('llama3:latest');
    expect((await getSlotConnectionMaterial('openrouter'))?.apiKey).toBe('sk-or-persisted');
  });

  it('still has both slots and appDefault after a store reload', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    ensureV2Document();
    const status = await getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('local');
    expect(status.slots.local?.modelId).toBe('qwen3:14b');
    expect(status.slots.openrouter?.modelId).toBe('openai/gpt-4o');
  });

  it('persists OAuth credentials before model selection on the openrouter slot', async () => {
    const result = await saveOAuthCredentials({
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
    expect((await getStoredLlmConnectionMaterial())?.apiKey).toBe('sk-or-persisted');
    expect(await getLlmConnection()).toBeNull();
  });

  it('keeps the OpenRouter model when the user signs in again', async () => {
    const oauthInput = {
      providerId: 'openrouter',
      providerDisplayName: 'OpenRouter',
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-first',
      authScheme: 'bearer' as const,
      capabilities: OAUTH_LLM_CAPABILITIES,
    };
    await saveOAuthCredentials(oauthInput);
    await updateLlmModel('openai/gpt-4o', 'openrouter');

    const result = await saveOAuthCredentials({ ...oauthInput, apiKey: 'sk-or-second' });

    expect(result.status?.slots.openrouter?.modelId).toBe('openai/gpt-4o');
    expect(result.status?.configured).toBe(true);
    expect(await getSlotApiKey('openrouter')).toBe('sk-or-second');
  });

  it('classifies IPv6 loopback endpoints as local', () => {
    expect(classifyInferenceSlot({ provider: 'manual', endpointUrl: 'http://[::1]:8080/v1' })).toBe('local');
    expect(classifyInferenceSlot({ provider: 'manual', endpointUrl: 'https://other.example/v1' })).toBe(
      'infrastructure'
    );
  });

  it('updates a selectable model on the app-default slot', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://example.test/v1',
      apiKey: 'sk-test-key',
      modelId: 'openai/gpt-4o',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    const result = await updateLlmModel('anthropic/claude-sonnet-4.6');
    expect(result.success).toBe(true);
    expect(result.status?.slots.infrastructure?.modelId).toBe('anthropic/claude-sonnet-4.6');
  });

  it('keeps a slot key on a blank-key save only while the slot URL is unchanged', async () => {
    await saveLlmConnection({
      endpointUrl: 'https://first.example/v1',
      apiKey: 'sk-first',
      modelId: 'm',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    const sameUrl = await saveLlmConnection({
      endpointUrl: 'https://first.example/v1/',
      modelId: 'm2',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });
    expect(sameUrl.success).toBe(true);
    expect(await getSlotApiKey('infrastructure')).toBe('sk-first');

    const otherUrl = await saveLlmConnection({
      endpointUrl: 'https://second.example/v1',
      modelId: 'm',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });
    expect(otherUrl.success).toBe(false);
    expect(otherUrl.error).toBe('Enter an API key.');
    expect(otherUrl.status?.slots.infrastructure?.endpointUrl).toBe('https://first.example/v1');
  });

  it('saves a first keyless local server with a placeholder key', async () => {
    const result = await saveLlmConnection({
      endpointUrl: 'http://127.0.0.1:8080/v1',
      modelId: 'm',
      provider: 'local-manual',
      providerDisplayName: 'Local server',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(result.success).toBe(true);
    expect(result.status?.slots.local?.configured).toBe(true);
    expect(await getSlotApiKey('local')).toBe('local');
  });

  it('refuses setAppDefault on an empty slot', async () => {
    const result = await setAppDefault('openrouter');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connect that provider/i);
    expect(getAppDefaultSlot()).toBeNull();
  });

  it('disconnects the default and falls back to the other configured visible slot', async () => {
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'llama3:latest',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    const result = await clearLlmSlot('local');
    expect(result.success).toBe(true);
    expect(result.status?.appDefault).toBe('openrouter');
    expect(result.status?.slots.local).toBeUndefined();
    expect((await getLlmConnection())?.provider).toBe('openrouter');
  });

  it('saves a local LLM endpoint with modelId', async () => {
    const result = await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'llama3:latest',
    });

    expect(result.success).toBe(true);
    expect(result.status?.slots.local?.modelId).toBe('llama3:latest');
    expect(await getSlotApiKey(getAppDefaultSlot())).toBe('ollama');
  });

  it('migrates a v1 local document into the local slot as appDefault', async () => {
    const encryptedApiKey = (await safeStorage.encryptStringAsync('ollama')).toString('base64');
    writeV1DocumentForTesting({
      endpointUrl: 'http://127.0.0.1:11434/v1',
      encryptedApiKey,
      modelId: 'qwen3:14b',
      provider: 'ollama',
      providerDisplayName: 'Ollama',
      authScheme: 'bearer',
      capabilities: LOCAL_LLM_CAPABILITIES,
    });

    const status = await getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('local');
    expect(status.configured).toBe(true);
    expect(status.slots.local?.modelId).toBe('qwen3:14b');
    expect((await getLlmConnection())?.modelId).toBe('qwen3:14b');
  });

  it('migrates a v1 OpenRouter document into the openrouter slot', async () => {
    const encryptedApiKey = (await safeStorage.encryptStringAsync('sk-or-legacy')).toString('base64');
    writeV1DocumentForTesting({
      endpointUrl: 'https://openrouter.ai/api/v1',
      encryptedApiKey,
      modelId: 'openai/gpt-4o',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });

    const status = await getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('openrouter');
    expect((await getLlmConnection())?.apiKey).toBe('sk-or-legacy');
  });

  it('migrates a v1 Baseten document into infrastructure', async () => {
    const encryptedApiKey = (await safeStorage.encryptStringAsync('bt-legacy')).toString('base64');
    writeV1DocumentForTesting({
      endpointUrl: 'https://model-abc.api.baseten.co/environments/production/sync/v1',
      encryptedApiKey,
      modelId: 'model-abc',
      provider: 'baseten',
    });

    const status = await getOpenAiOnboardingStatus();
    expect(status.appDefault).toBe('infrastructure');
    expect(status.slots.infrastructure?.provider).toBe('baseten');
    expect((await getLlmConnection())?.modelId).toBe('model-abc');
  });

  it('does not save API keys when OS encryption is unavailable', async () => {
    vi.spyOn(safeStorage, 'isAsyncEncryptionAvailable').mockResolvedValue(false);

    const result = await saveLlmConnection({
      endpointUrl: 'https://example.test/v1',
      apiKey: 'sk-test-key',
      modelId: 'openai/gpt-4o',
      provider: 'manual',
      capabilities: MANUAL_LLM_CAPABILITIES,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('OS encryption is not available');
    expect(await getSlotApiKey(getAppDefaultSlot())).toBeNull();
  });
});
