import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../../shared/llmConnectionDefaults';
import { clearLastAppliedLlm, setLastAppliedLlm } from '../../AssistantStackStore';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
} from '../../../onboarding/OpenAiOnboardingStore';
import {
  resetHermesAgentsStoreForTests,
  setSessionInference,
} from '../hermesAgentStore';

const probeSlotHealth = vi.fn();
const applyLlmConnectionToHermes = vi.fn();

vi.mock('../../../onboarding/probeSlotHealth', () => ({
  probeSlotHealth: (...args: unknown[]) => probeSlotHealth(...args),
}));

vi.mock('../../AssistantStackService', () => ({
  applyLlmConnectionToHermes: (...args: unknown[]) => applyLlmConnectionToHermes(...args),
  applyLlmSlotToHermes: vi.fn(),
}));

describe('ensureResolvedInferenceReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOpenAiConfig();
    resetHermesAgentsStoreForTests();
    clearLastAppliedLlm();
    saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
  });

  it('probes local and refuses cloud fallback when unreachable', async () => {
    probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('local-unreachable');
    }
    expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
  });

  it('applies the resolved slot when Hermes is on a different connection', async () => {
    saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    setSessionInference('s1', {
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    setLastAppliedLlm({
      slot: 'local',
      endpointUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'qwen3:14b',
      appliedAt: '2026-09-28T00:00:00.000Z',
    });
    applyLlmConnectionToHermes.mockResolvedValue({ success: true });
    const onRestarting = vi.fn();
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1', onRestarting);
    expect(onRestarting).toHaveBeenCalled();
    expect(applyLlmConnectionToHermes).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'anthropic/claude-sonnet-4',
        slot: 'openrouter',
      })
    );
    expect(result.ok).toBe(true);
  });
});
