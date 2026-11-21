import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOpenAiConfig,
  getLlmConnection,
  getOpenAiOnboardingStatus,
  saveLlmConnection,
} from '../../onboarding/OpenAiOnboardingStore';
import {
  getAppDefaultSlot,
  getAppFallbacks,
  getAppSharedModel,
  setAppDefault,
  setAppFallbacks,
  setAppSharedModel,
} from '../appInferenceChoice';
import { OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';

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

  it('refuses setAppDefault on an empty slot', async () => {
    const result = await setAppDefault('openrouter');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Connect that provider/i);
    expect(getAppDefaultSlot()).toBeNull();
  });
});
