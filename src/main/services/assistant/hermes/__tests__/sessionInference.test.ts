import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_LLM_CAPABILITIES } from '../../../../../shared/llmConnectionDefaults';
import { clearLastAppliedLlm, setLastAppliedLlm } from '../../AssistantStackStore';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  setAppDefault,
  setAppFallbacks,
} from '../../../onboarding/OpenAiOnboardingStore';
import type { ProjectInferencePin } from '../../../../../shared/types/hermesChat';
import type { InferenceChainEntry } from '../../../../../shared/types/inferenceChain';
import { setConversationProjectId } from '../hermesChatProjects';
import {
  getStoredHermesProject,
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
} from '../hermesProjectStore';
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
let latestServed: Record<string, unknown> | null = null;
const sharedProviderNames = vi.fn();
let providerPrivate = false;
const setInferenceRouterChain = vi.fn();
vi.mock('../../../inference/inferenceRouterService', () => ({
  inferenceRouterPushed: () => routerPushed,
  setInferenceRouterChain: (...args: unknown[]) => setInferenceRouterChain(...args),
  latestInferenceRouterServed: () => latestServed,
}));

vi.mock('../../../circles/circlesService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../circles/circlesService')>()),
  sharedProviderNames: (...args: unknown[]) => sharedProviderNames(...args),
  sharedModelFacts: () => ({
    providerPrivate: () => providerPrivate,
    providerTrusted: () => true,
    circleJoined: () => true,
    peerOffer: () => ({ 'qwen3-8b': { contextLength: 16_384 } }),
  }),
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

describe('a private project (ADR 0033 §4)', () => {
  const peer: InferenceChainEntry = {
    slot: 'peer',
    modelId: 'qwen3-8b',
    peer: { circleId: 'circle', providerId: 'bo' },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearOpenAiConfig();
    resetHermesAgentsStoreForTests();
    resetHermesProjectsStoreForTests();
    clearLastAppliedLlm();
    resetRunningTurnsForTests();
    routerPushed = false;
    providerPrivate = false;
    await saveLocalLlmEndpoint({
      runtime: 'ollama',
      endpointUrl: 'http://127.0.0.1:11434/v1/',
      modelId: 'qwen3:14b',
    });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    upsertStoredHermesProject({
      id: 'p1',
      name: 'Job Search',
      hostPath: '/tmp/job',
      containerPath: '/opt/projects/job',
      slug: 'job',
      kind: 'host-folder',
      inference: { mode: 'local', modelId: 'qwen3:14b', privacyLocalOnly: true },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    setConversationProjectId(['s1'], 'p1');
    applyLlmConnectionToHermes.mockResolvedValue({ success: true });
    probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
  });

  const pin = (inference: ProjectInferencePin) =>
    upsertStoredHermesProject({ ...getStoredHermesProject('p1')!, inference: { ...inference, privacyLocalOnly: true } });

  it('refuses a one-entry OpenRouter chain and applies nothing', async () => {
    pin({ mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1');
    expect(result).toMatchObject({ ok: false, errorCode: 'private-refused' });
    expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
  });

  it('refuses a chat already pinned to OpenRouter, and keeps the pin for when Private is off', async () => {
    setSessionInference('s1', { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    const { ensureResolvedInferenceReady, getSessionInferenceSnapshot } = await import('../sessionInference');
    expect(await ensureResolvedInferenceReady('s1')).toMatchObject({ ok: false, errorCode: 'private-refused' });
    const snapshot = await getSessionInferenceSnapshot('s1');
    expect(snapshot.override).toMatchObject({ provider: 'openrouter' });
    expect(snapshot.resolved).toMatchObject({ privacyLocked: true, privacyRefused: true });
  });

  it('refuses a cloud app default when the project inherits', async () => {
    pin({ mode: 'inherit' });
    await setAppDefault('openrouter');
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect(await ensureResolvedInferenceReady('s1')).toMatchObject({ ok: false, errorCode: 'private-refused' });
  });

  it('refuses a chain that starts in the cloud, though a private entry follows', async () => {
    pin({ mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4', fallbacks: [{ slot: 'local' }] });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect(await ensureResolvedInferenceReady('s1')).toMatchObject({ ok: false, errorCode: 'private-refused' });
  });

  it('cuts a cloud fallback, so an unreachable local model stops without offering it', async () => {
    pin({ mode: 'local', modelId: 'qwen3:14b', fallbacks: [{ slot: 'openrouter' }] });
    probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1');
    expect(result).toMatchObject({ ok: false, errorCode: 'local-unreachable' });
    expect(JSON.stringify(result)).not.toContain('OpenRouter');
  });

  it('leaves a routed chain for the direct local model once the lock cuts it to one entry', async () => {
    pin({ mode: 'local', modelId: 'qwen3:14b', fallbacks: [{ slot: 'openrouter' }] });
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
    expect(setInferenceRouterChain).not.toHaveBeenCalled();
    expect(applyLlmConnectionToHermes.mock.calls[0][0].plan).toBeUndefined();
  });

  it('sends to a shared model whose provider is marked private', async () => {
    providerPrivate = true;
    pin({ mode: 'local', modelId: 'qwen3:14b', fallbacks: [peer, { slot: 'openrouter' }] });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
    const { plan } = applyLlmConnectionToHermes.mock.calls[0][0];
    expect(Object.keys(plan.chain.upstreams)).toEqual(['local:qwen3:14b', 'peer:circle:bo:qwen3-8b']);
  });

  it('cuts a shared model whose provider is not marked private', async () => {
    pin({ mode: 'local', modelId: 'qwen3:14b', fallbacks: [peer] });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
    expect(applyLlmConnectionToHermes.mock.calls[0]?.[0]?.plan).toBeUndefined();
  });

  it("won't widen the router's chain under a running private turn", async () => {
    await setAppFallbacks([{ slot: 'openrouter' }]);
    setLastAppliedLlm({
      slot: 'local',
      endpointUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'qwen3:14b',
      contextLength: 32_768,
      routed: true,
      appliedAt: '2026-10-29T00:00:00.000Z',
    });
    routerPushed = true;
    beginRunningTurn('private-turn', ['s1'], null);
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('other-chat');
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('private project') });
    expect(setInferenceRouterChain).not.toHaveBeenCalled();
  });

  it('refuses to start a chat on a cloud model, and allows local', async () => {
    const { setSessionInferenceOverride } = await import('../sessionInference');
    const cloud = await setSessionInferenceOverride({
      sessionId: 's1',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(cloud).toMatchObject({ success: false, override: null });
    const local = await setSessionInferenceOverride({ sessionId: 's1', provider: 'local', modelId: 'qwen3:14b' });
    expect(local.success).toBe(true);
  });
});

describe('noteFallbackServed', () => {
  const peer = { circleId: 'c1', providerId: 'p1' };

  beforeEach(() => {
    resetHermesAgentsStoreForTests();
    sharedProviderNames.mockReturnValue({ person: 'Ada', circle: 'Friends' });
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: true, at: 2_000 };
  });

  it('marks a chat that a shared model answered, with who shared it, once per run of turns', async () => {
    const { noteFallbackServed } = await import('../sessionInference');
    const { listSessionInferenceMarks } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000);
    noteFallbackServed('s1', 1_000);
    expect(listSessionInferenceMarks('s1')).toEqual([
      expect.objectContaining({
        kind: 'fell-back',
        provider: 'peer',
        modelId: 'qwen3:14b',
        sharedBy: { person: 'Ada', circle: 'Friends' },
      }),
    ]);
  });

  it('still marks a shared model once its provider has left the Circle', async () => {
    sharedProviderNames.mockReturnValue(null);
    const { noteFallbackServed } = await import('../sessionInference');
    const { listSessionInferenceMarks } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000);
    const [mark] = listSessionInferenceMarks('s1');
    expect(mark.provider).toBe('peer');
    expect(mark.sharedBy).toBeUndefined();
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
