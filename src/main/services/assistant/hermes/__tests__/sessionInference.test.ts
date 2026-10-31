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
  ensureCirclesStarted: async () => undefined,
  sharedModelFacts: () => ({
    running: true,
    identity: 'a'.repeat(64),
    providerName: () => 'Bo',
    providerOnline: () => true,
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
    probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
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

  describe('before switching provider', () => {
    it('refuses without applying when OpenRouter doesn’t answer, and says no more than that', async () => {
      needRestartToOpenRouter();
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable', error: 'fetch failed' });
      const onApply = vi.fn();
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect(await ensureResolvedInferenceReady('s1', onApply)).toEqual({
        ok: false,
        error: 'OpenRouter didn’t answer, so your message wasn’t sent.',
        errorCode: 'provider-unreachable',
      });
      expect(probeSlotHealth).toHaveBeenCalledWith('openrouter');
      expect(onApply).not.toHaveBeenCalled();
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
    });

    it('lets a bad key through: the provider answered, and Hermes reports it', async () => {
      needRestartToOpenRouter();
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unauthorized' });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      expect(applyLlmConnectionToHermes).toHaveBeenCalled();
    });

    it('adds no probe to an ordinary send on OpenRouter', async () => {
      needRestartToOpenRouter();
      setLastAppliedLlm({
        slot: 'openrouter',
        endpointUrl: 'https://openrouter.ai/api/v1',
        modelId: 'anthropic/claude-sonnet-4',
        appliedAt: '2026-09-28T00:00:00.000Z',
      });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      expect(probeSlotHealth).not.toHaveBeenCalled();
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
    });

    it('tells the listener before applying, and of a restart only when Hermes restarts', async () => {
      needRestartToOpenRouter();
      probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
      const onApply = vi.fn();
      applyLlmConnectionToHermes.mockImplementation(async (_llm, { onRestart }) => {
        expect(onApply.mock.calls.map((call) => call[2])).toEqual([false]);
        onRestart();
        return { success: true };
      });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      await ensureResolvedInferenceReady('s1', onApply);
      expect(onApply.mock.calls.map((call) => call[2])).toEqual([false, true]);

      onApply.mockClear();
      applyLlmConnectionToHermes.mockResolvedValue({ success: true });
      await ensureResolvedInferenceReady('s1', onApply);
      expect(onApply.mock.calls.map((call) => call[2])).toEqual([false]);
    });
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
      }),
      expect.anything()
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
      probeSlotHealth.mockImplementation(async (slot: string) => ({
        success: true,
        health: slot === 'local' ? 'unreachable' : 'reachable',
      }));
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      const result = await ensureResolvedInferenceReady('s1');
      expect(result.ok).toBe(true);
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

    it('refuses before an apply when nothing in the chain answers', async () => {
      await localThenOpenRouter();
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect(await ensureResolvedInferenceReady('s1')).toEqual({
        ok: false,
        error: 'Your local model and OpenRouter didn’t answer, so your message wasn’t sent.',
        errorCode: 'provider-unreachable',
      });
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
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

  it('marks the primary answering again, once, and a later fall back as a new run', async () => {
    const { noteFallbackServed } = await import('../sessionInference');
    const { listSessionInferenceMarks } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000);
    latestServed = { slot: 'openrouter', modelId: 'x/primary', fellBack: false, at: 3_000 };
    noteFallbackServed('s1', 2_500);
    noteFallbackServed('s1', 2_500);
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: true, at: 5_000 };
    noteFallbackServed('s1', 4_000);
    expect(listSessionInferenceMarks('s1').map((mark) => [mark.kind, mark.provider])).toEqual([
      ['fell-back', 'peer'],
      ['recovered', 'openrouter'],
      ['fell-back', 'peer'],
    ]);
  });

  it('names who shares a shared primary when it answers again', async () => {
    const { noteFallbackServed } = await import('../sessionInference');
    const { appendSessionInferenceMark, listSessionInferenceMarks } = await import('../hermesAgentStore');
    appendSessionInferenceMark('s1', { kind: 'fell-back', provider: 'openrouter', modelId: 'x/backup' });
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: false, at: 2_000 };
    noteFallbackServed('s1', 1_000);
    expect(listSessionInferenceMarks('s1').at(-1)).toEqual(
      expect.objectContaining({ kind: 'recovered', provider: 'peer', sharedBy: { person: 'Ada', circle: 'Friends' } })
    );
  });

  it('marks nothing when the primary answers a chat that never fell back', async () => {
    latestServed = { slot: 'openrouter', modelId: 'x/primary', fellBack: false, at: 2_000 };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listSessionInferenceMarks } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000);
    expect(listSessionInferenceMarks('s1')).toEqual([]);
  });

  describe('a turn the router did not serve', () => {
    const direct = { slot: 'openrouter' as const, endpointUrl: 'https://x.test/v1', modelId: 'x/primary', appliedAt: 't' };

    async function afterFallback() {
      const { appendSessionInferenceMark, listSessionInferenceMarks } = await import('../hermesAgentStore');
      appendSessionInferenceMark('s1', { kind: 'fell-back', provider: 'peer', modelId: 'qwen3:14b' });
      return listSessionInferenceMarks;
    }

    it('counts as the primary when it replied past a chain cut to one entry', async () => {
      const list = await afterFallback();
      setLastAppliedLlm(direct);
      const { noteFallbackServed } = await import('../sessionInference');
      noteFallbackServed('s1', 9_000, true);
      expect(list('s1').at(-1)).toEqual(
        expect.objectContaining({ kind: 'recovered', provider: 'openrouter', modelId: 'x/primary' })
      );
    });

    it('says nothing when it failed, or when the chain is still routed', async () => {
      const list = await afterFallback();
      const { noteFallbackServed } = await import('../sessionInference');
      setLastAppliedLlm(direct);
      noteFallbackServed('s1', 9_000, false);
      setLastAppliedLlm({ ...direct, routed: true });
      noteFallbackServed('s1', 9_000, true);
      expect(list('s1').map((mark) => mark.kind)).toEqual(['fell-back']);
    });
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
