import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../../shared/llmConnectionDefaults';
import { clearLastAppliedLlm, setLastAppliedLlm } from '../../AssistantStackStore';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  setAppFallbacks,
} from '../../../onboarding/OpenAiOnboardingStore';
import {
  resetHermesAgentsStoreForTests,
  setSessionInference,
} from '../hermesAgentStore';
import { beginRunningTurn, resetRunningTurnsForTests } from '../hermesRunningTurns';

const probeSlotHealth = vi.fn();
const applyLlmConnectionToHermes = vi.fn();

vi.mock('../../../onboarding/probeSlotHealth', () => ({
  probeSlotHealth: (...args: unknown[]) => probeSlotHealth(...args),
}));

let routerPushed = false;
const setInferenceRouterChain = vi.fn();
vi.mock('../../../inference/inferenceRouterService', () => ({
  inferenceRouterPushed: () => routerPushed,
  setInferenceRouterChain: (...args: unknown[]) => setInferenceRouterChain(...args),
}));

vi.mock('../../hermesProfileLimits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hermesProfileLimits')>()),
  lookupModelContextLength: async ({ modelId }: { modelId: string }) =>
    modelId === 'qwen3:14b' ? 32_768 : 200_000,
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
    resetRunningTurnsForTests();
    routerPushed = false;
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

  function needRestartToOpenRouter() {
    saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    setSessionInference('s1', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    setLastAppliedLlm({
      slot: 'local',
      endpointUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'qwen3:14b',
      appliedAt: '2026-09-28T00:00:00.000Z',
    });
    applyLlmConnectionToHermes.mockResolvedValue({ success: true });
  }

  it("refuses to restart Hermes under another chat's running turn (G07-3)", async () => {
    needRestartToOpenRouter();
    beginRunningTurn('req-other', ['local-chat'], null);
    const onRestarting = vi.fn();
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1', onRestarting);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/still running/);
    expect(onRestarting).not.toHaveBeenCalled();
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

  describe('with app default fallbacks (ADR 0033)', () => {
    async function localThenOpenRouter() {
      await saveLlmConnection({
        endpointUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'sk-or-key',
        modelId: 'anthropic/claude-sonnet-4',
        provider: 'openrouter',
        capabilities: OAUTH_LLM_CAPABILITIES,
      });
      expect((await setAppFallbacks([{ slot: 'openrouter' }])).success).toBe(true);
      applyLlmConnectionToHermes.mockResolvedValue({ success: true });
    }

    it('does not stop for an unreachable local model, and applies the routed chain', async () => {
      await localThenOpenRouter();
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      const result = await ensureResolvedInferenceReady('s1');
      expect(result.ok).toBe(true);
      expect(probeSlotHealth).not.toHaveBeenCalled();
      const [connection] = applyLlmConnectionToHermes.mock.calls[0];
      expect(connection).toMatchObject({ slot: 'local', modelId: 'qwen3:14b', plan: { kind: 'routed' } });
      expect(connection.plan.chain.contextLength).toBe(32_768);
      expect(Object.keys(connection.plan.chain.upstreams)).toEqual(['local:qwen3:14b', 'openrouter:']);
    });

    it('only hands the router the chain when Hermes already serves it', async () => {
      await localThenOpenRouter();
      setLastAppliedLlm({
        slot: 'local',
        endpointUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:14b',
        contextLength: 32_768,
        routed: true,
        appliedAt: '2026-10-29T00:00:00.000Z',
      });
      routerPushed = true;
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
      expect(setInferenceRouterChain).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'qwen3:14b' }));
    });

    it('applies again when this run never pointed the proxy at the router', async () => {
      await localThenOpenRouter();
      setLastAppliedLlm({
        slot: 'local',
        endpointUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:14b',
        contextLength: 32_768,
        routed: true,
        appliedAt: '2026-10-29T00:00:00.000Z',
      });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      await ensureResolvedInferenceReady('s1');
      expect(applyLlmConnectionToHermes).toHaveBeenCalledTimes(1);
    });

    it("serves a chat override's own fallbacks, not the app default's", async () => {
      await localThenOpenRouter();
      await setAppFallbacks([]);
      setSessionInference('s1', {
        provider: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        fallbacks: [{ slot: 'local' }],
      });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      const [connection] = applyLlmConnectionToHermes.mock.calls[0];
      expect(connection).toMatchObject({ slot: 'openrouter', plan: { kind: 'routed' } });
      expect(Object.keys(connection.plan.chain.upstreams)).toEqual([
        'openrouter:anthropic/claude-sonnet-4',
        'local:',
      ]);
    });

    it('a chat override without fallbacks is one entry: it leaves the chain and keeps the local hard stop', async () => {
      await localThenOpenRouter();
      setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b' });
      setLastAppliedLlm({
        slot: 'local',
        endpointUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:14b',
        routed: true,
        appliedAt: '2026-10-29T00:00:00.000Z',
      });
      probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      expect(probeSlotHealth).toHaveBeenCalled();
      const [connection] = applyLlmConnectionToHermes.mock.calls[0];
      expect(connection.plan).toBeUndefined();
    });
  });
});

describe('setSessionInferenceOverride fallbacks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearOpenAiConfig();
    resetHermesAgentsStoreForTests();
    saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
  });

  async function connectOpenRouter() {
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
  }

  it('keeps the fallbacks when a pick omits them, and drops one that became the pick', async () => {
    await connectOpenRouter();
    const { setSessionInferenceOverride } = await import('../sessionInference');
    const set = await setSessionInferenceOverride({
      sessionId: 's1',
      provider: 'local',
      modelId: 'qwen3:14b',
      fallbacks: [{ slot: 'openrouter' }],
    });
    expect(set.override?.fallbacks).toEqual([{ slot: 'openrouter' }]);

    const same = await setSessionInferenceOverride({ sessionId: 's1', provider: 'local', modelId: '' });
    expect(same.override?.fallbacks).toEqual([{ slot: 'openrouter' }]);

    const swapped = await setSessionInferenceOverride({ sessionId: 's1', provider: 'openrouter', modelId: '' });
    expect(swapped.override).toEqual({ provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
  });

  it('refuses a fallback that is not connected and keeps the override as it was', async () => {
    const { setSessionInferenceOverride } = await import('../sessionInference');
    const result = await setSessionInferenceOverride({
      sessionId: 's1',
      provider: 'local',
      modelId: 'qwen3:14b',
      fallbacks: [{ slot: 'openrouter' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connect that provider/i);
    expect(result.override).toBeNull();
  });
});
