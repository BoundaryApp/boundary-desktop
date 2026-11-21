import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS } from '../../../../../shared/types/confidential';
import { OAUTH_LLM_CAPABILITIES } from '../../../../../shared/llmConnectionDefaults';
import { clearLastAppliedLlm, setLastAppliedLlm } from '../../AssistantStackStore';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  saveLocalLlmEndpoint,
} from '../../../onboarding/OpenAiOnboardingStore';
import { setAppDefault, setAppFallbacks, setAppSharedModel } from '../../../inference/appInferenceChoice';
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
import { beginRunningTurn, poolFloorSent, resetRunningTurnsForTests } from '../hermesRunningTurns';

const probeSlotHealth = vi.fn();
const applyLlmConnectionToHermes = vi.fn();

vi.mock('../../../onboarding/probeSlotHealth', () => ({
  probeSlotHealth: (...args: unknown[]) => probeSlotHealth(...args),
}));

let routerPushed = false;
let latestServed: Record<string, unknown> | null = null;
/** The router's latest record per session key, as `latestInferenceRouterServed(key)` reads it. */
let servedBySession: Record<string, Record<string, unknown>> = {};
/** The pool move each session's requests left since it was last taken. */
let pendingMoves: Record<string, string> = {};
/** Sessions whose pool requests were answered by more than one provider since last taken. */
const mixedSessions = new Set<string>();
/** Each take's session key and turn start. */
const takenSince: Array<[string, number]> = [];
const sharedProviderNames = vi.fn();
let providerPrivate = false;
const setInferenceRouterChain = vi.fn();
vi.mock('../../../inference/inferenceRouterService', () => ({
  inferenceRouterPushed: () => routerPushed,
  setInferenceRouterChain: (...args: unknown[]) => setInferenceRouterChain(...args),
  latestInferenceRouterServed: (key?: string | null) => (key ? (servedBySession[key] ?? null) : latestServed),
  takeInferenceRouterPoolTurn: (key: string, since: number) => {
    takenSince.push([key, since]);
    const moved = pendingMoves[key] ?? null;
    const mixedProviders = mixedSessions.has(key);
    delete pendingMoves[key];
    mixedSessions.delete(key);
    return { moved, mixedProviders };
  },
}));

vi.mock('../../../circles/circlesService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../circles/circlesService')>()),
  sharedProviderNames: (...args: unknown[]) => sharedProviderNames(...args),
  ensureCirclesStarted: async (): Promise<void> => undefined,
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
  settleHermesApply: async (): Promise<void> => undefined,
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
    if (result.ok === false) {
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
    if (result.ok === false) expect(result.error).toMatch(/still running/);
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

describe('a chain that lists a confidential pool', () => {
  const pool: InferenceChainEntry = { slot: 'confidential', modelId: 'qwen' };
  const poolStatus = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
    clearOpenAiConfig();
    resetHermesAgentsStoreForTests();
    clearLastAppliedLlm();
    resetRunningTurnsForTests();
    routerPushed = false;
    saveLocalLlmEndpoint({ runtime: 'ollama', endpointUrl: 'http://127.0.0.1:11434/v1/', modelId: 'qwen3:14b' });
    applyLlmConnectionToHermes.mockResolvedValue({ success: true });
    poolStatus.mockResolvedValue({ serves: true, servesPrivate: false, contextLength: 8_192 });
    const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
    setInferenceChainConfidential({ poolSettings: () => ({ ...DEFAULT_POOL_SETTINGS, privateFloor: 'B' }), poolStatus });
  });

  afterEach(async () => {
    const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
    setInferenceChainConfidential(null);
  });

  it('skips a pool nobody serves and serves local directly', async () => {
    poolStatus.mockResolvedValue({ serves: false, servesPrivate: false, contextLength: null });
    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b', fallbacks: [pool] });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1');
    expect(result).toMatchObject({ ok: true, resolved: { slot: 'local', modelId: 'qwen3:14b' } });
    const [connection] = applyLlmConnectionToHermes.mock.calls[0];
    expect(connection).toMatchObject({ slot: 'local', modelId: 'qwen3:14b' });
    expect(connection.plan).toBeUndefined();
  });

  it('routes a chain whose only fallback is a pool that serves, judged at the private minimum', async () => {
    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b', fallbacks: [pool] });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
    expect(poolStatus).toHaveBeenCalledWith('qwen', { projectFloor: 'B' });
    const [connection] = applyLlmConnectionToHermes.mock.calls[0];
    expect(connection.plan).toMatchObject({ kind: 'routed' });
    expect(Object.keys(connection.plan.chain.upstreams)).toEqual(['local:qwen3:14b', 'confidential:qwen']);
  });

  it('never probes a pool, and doesn’t stop a send the pool can answer', async () => {
    setSessionInference('s1', { provider: 'local', modelId: 'qwen3:14b', fallbacks: [pool] });
    probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
    expect(probeSlotHealth.mock.calls.map(([slot]) => slot)).not.toContain('confidential');
  });

  it('probes only the slots when the pool can’t serve and nothing answers', async () => {
    poolStatus.mockResolvedValue({ serves: false, servesPrivate: false, contextLength: null });
    await saveLlmConnection({
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      capabilities: OAUTH_LLM_CAPABILITIES,
    });
    expect((await setAppFallbacks([pool, { slot: 'openrouter' }])).success).toBe(true);
    probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect(await ensureResolvedInferenceReady('s1')).toEqual({
      ok: false,
      error: 'Your local model and OpenRouter didn’t answer, so your message wasn’t sent.',
      errorCode: 'provider-unreachable',
    });
    expect(probeSlotHealth.mock.calls.map(([slot]) => slot)).toEqual(['local', 'openrouter']);
  });

  it('plans and routes an app stack that starts with a pool, with no other fallback', async () => {
    expect((await setAppSharedModel(pool)).success).toBe(true);
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    const result = await ensureResolvedInferenceReady('s1');
    expect(result).toMatchObject({ ok: true, resolved: { slot: 'confidential', modelId: 'qwen', providerDisplayName: 'Confidential' } });
    expect(probeSlotHealth).not.toHaveBeenCalled();
    const [connection] = applyLlmConnectionToHermes.mock.calls[0];
    expect(connection).toMatchObject({
      slot: 'confidential',
      modelId: 'qwen',
      endpointUrl: 'https://confidential-pool.invalid',
      plan: { kind: 'routed', chain: { contextLength: 8_192 } },
    });
  });

  it('refuses an app stack that starts with a pool nobody serves', async () => {
    poolStatus.mockResolvedValue({ serves: false, servesPrivate: false, contextLength: null });
    expect((await setAppSharedModel(pool)).success).toBe(true);
    const { ensureResolvedInferenceReady } = await import('../sessionInference');
    expect(await ensureResolvedInferenceReady('s1')).toEqual({
      ok: false,
      error: 'No added provider serves qwen now. Your message wasn’t sent. You can pick another model in Inference.',
      errorCode: 'apply-failed',
    });
    expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
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

  it('won’t swap in an unlocked chat’s pool under a running private turn, though the pool serves private projects', async () => {
    const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
    setInferenceChainConfidential({
      poolSettings: () => DEFAULT_POOL_SETTINGS,
      poolStatus: async () => ({ serves: true, servesPrivate: true, contextLength: 8_192 }),
    });
    try {
      setSessionInference('other-chat', {
        provider: 'local',
        modelId: 'qwen3:14b',
        fallbacks: [{ slot: 'confidential', modelId: 'qwen' }],
      });
      setLastAppliedLlm({
        slot: 'local',
        endpointUrl: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen3:14b',
        contextLength: 8_192,
        routed: true,
        appliedAt: '2026-10-29T00:00:00.000Z',
      });
      routerPushed = true;
      beginRunningTurn('private-turn', ['s1'], null);
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      const result = await ensureResolvedInferenceReady('other-chat');
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('private project') });
      expect(setInferenceRouterChain).not.toHaveBeenCalled();
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
    } finally {
      setInferenceChainConfidential(null);
    }
  });

  describe('Allow level B', () => {
    const pool: InferenceChainEntry = { slot: 'confidential', modelId: 'qwen' };
    /** Only level B providers serve qwen: a private project reaches them only at floor B. */
    const poolStatus = vi.fn(async (_modelId: string, { projectFloor }: { projectFloor: string }) => ({
      serves: true,
      servesPrivate: projectFloor === 'B',
      contextLength: 8_192,
    }));

    beforeEach(async () => {
      const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
      setInferenceChainConfidential({ poolSettings: () => DEFAULT_POOL_SETTINGS, poolStatus });
    });

    afterEach(async () => {
      const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
      setInferenceChainConfidential(null);
    });

    const allowB = (projectId: string, allowConfidentialLevelB: boolean) => {
      const project = getStoredHermesProject(projectId)!;
      upsertStoredHermesProject({ ...project, inference: { ...project.inference!, allowConfidentialLevelB } });
    };

    it('floor is B when the pin allows level B', async () => {
      pin({ mode: 'local', modelId: 'qwen3:14b', fallbacks: [pool], allowConfidentialLevelB: true });
      const { ensureResolvedInferenceReady, getSessionInferenceSnapshot } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      expect(poolStatus).toHaveBeenCalledWith('qwen', { projectFloor: 'B' });
      const { plan } = applyLlmConnectionToHermes.mock.calls[0][0];
      expect(plan.chain.upstreams['confidential:qwen'].pool).toEqual({
        modelId: 'qwen',
        privateProject: true,
        projectFloor: 'B',
      });
      expect((await getSessionInferenceSnapshot('s1')).resolved).toMatchObject({ privacyLocked: true, projectFloor: 'B' });
    });

    it('undoing Allow level B stops the next send', async () => {
      pin({ mode: 'inherit', allowConfidentialLevelB: true });
      expect((await setAppSharedModel(pool)).success).toBe(true);
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      applyLlmConnectionToHermes.mockClear();

      allowB('p1', false);
      expect(await ensureResolvedInferenceReady('s1')).toMatchObject({ ok: false, errorCode: 'private-refused' });
      expect(poolStatus).toHaveBeenLastCalledWith('qwen', { projectFloor: 'A' });
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
    });

    it('refuses OpenRouter then a pool only level B serves, and the chat’s snapshot says why per provider', async () => {
      const stop = {
        modelId: 'qwen',
        floor: 'A' as const,
        lowestPrecision: 'fp8' as const,
        providers: [{ providerId: 'prem', name: 'Prem', level: 'B' as const, precision: null as null, reason: 'below-level' as const }],
      };
      const privateStop = vi.fn(async () => stop);
      const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
      setInferenceChainConfidential({ poolSettings: () => DEFAULT_POOL_SETTINGS, poolStatus, privateStop });
      pin({ mode: 'openrouter', modelId: 'anthropic/claude-sonnet-4', fallbacks: [pool] });
      const { ensureResolvedInferenceReady, getSessionInferenceSnapshot } = await import('../sessionInference');
      expect(await ensureResolvedInferenceReady('s1')).toMatchObject({ ok: false, errorCode: 'private-refused' });
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
      expect((await getSessionInferenceSnapshot('s1')).resolved).toMatchObject({
        privacyRefused: true,
        projectFloor: 'A',
        poolStop: stop,
      });
      expect(privateStop).toHaveBeenCalledWith('qwen', { projectFloor: 'A' });
    });

    describe('under a running private turn', () => {
      beforeEach(() => {
        // Another private project allows level B and routes local, then a pool only B serves.
        upsertStoredHermesProject({
          ...getStoredHermesProject('p1')!,
          id: 'p2',
          slug: 'p2',
          inference: {
            mode: 'local',
            modelId: 'qwen3:14b',
            privacyLocalOnly: true,
            allowConfidentialLevelB: true,
            fallbacks: [pool],
          },
        });
        setConversationProjectId(['other-chat'], 'p2');
        setLastAppliedLlm({
          slot: 'local',
          endpointUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'qwen3:14b',
          contextLength: 8_192,
          routed: true,
          appliedAt: '2026-10-29T00:00:00.000Z',
        });
        routerPushed = true;
      });

      it('won’t swap in a pool planned at level B while a level A turn runs', async () => {
        beginRunningTurn('private-turn', ['s1'], null);
        const { ensureResolvedInferenceReady } = await import('../sessionInference');
        expect(await ensureResolvedInferenceReady('other-chat')).toMatchObject({
          ok: false,
          error: expect.stringContaining('private project'),
        });
        expect(setInferenceRouterChain).not.toHaveBeenCalled();
      });

      it('swaps it in when the running turn’s project allows level B too', async () => {
        allowB('p1', true);
        beginRunningTurn('private-turn', ['s1'], null);
        const { ensureResolvedInferenceReady } = await import('../sessionInference');
        expect((await ensureResolvedInferenceReady('other-chat')).ok).toBe(true);
        expect(setInferenceRouterChain).toHaveBeenCalled();
      });

      it('holds a running turn to the floor it was sent at, though its project allows level B since', async () => {
        const { ensureResolvedInferenceReady } = await import('../sessionInference');
        await ensureResolvedInferenceReady('s1');
        beginRunningTurn('private-turn', ['s1'], null);
        allowB('p1', true);
        expect(await ensureResolvedInferenceReady('other-chat')).toMatchObject({ ok: false });
        expect(setInferenceRouterChain).not.toHaveBeenCalled();
      });

      it('keeps a running turn at its floor when another send for that chat goes ahead at level B', async () => {
        const { ensureResolvedInferenceReady } = await import('../sessionInference');
        expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
        beginRunningTurn('private-turn', ['s1'], null);
        allowB('p1', true);
        // A queued send for the same chat, on the local model Hermes already serves.
        setLastAppliedLlm({
          slot: 'local',
          endpointUrl: 'http://127.0.0.1:11434/v1',
          modelId: 'qwen3:14b',
          appliedAt: '2026-10-29T00:00:00.000Z',
        });
        expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
        expect(poolFloorSent('s1')).toBe('A');
      });
    });

    it('notes the floor only for a send that goes ahead', async () => {
      const { ensureResolvedInferenceReady } = await import('../sessionInference');
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
      expect(poolFloorSent('s1')).toBe('A');
      // Allowed level B, but the chat now starts on a pool nobody serves: refused, nothing sent.
      pin({ mode: 'inherit', allowConfidentialLevelB: true });
      expect((await setAppSharedModel(pool)).success).toBe(true);
      poolStatus.mockResolvedValueOnce({ serves: false, servesPrivate: false, contextLength: null });
      expect((await ensureResolvedInferenceReady('s1')).ok).toBe(false);
      expect(poolFloorSent('s1')).toBe('A');
    });
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
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: true, requestedAt: 2_000, at: 2_000 };
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
    latestServed = { slot: 'openrouter', modelId: 'x/primary', fellBack: false, requestedAt: 3_000, at: 3_000 };
    noteFallbackServed('s1', 2_500);
    noteFallbackServed('s1', 2_500);
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: true, requestedAt: 5_000, at: 5_000 };
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
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: false, requestedAt: 2_000, at: 2_000 };
    noteFallbackServed('s1', 1_000);
    expect(listSessionInferenceMarks('s1').at(-1)).toEqual(
      expect.objectContaining({ kind: 'recovered', provider: 'peer', sharedBy: { person: 'Ada', circle: 'Friends' } })
    );
  });

  it('dates a mark from the turn, so it sits above the reply it begins with', async () => {
    latestServed = { slot: 'peer', peer, modelId: 'qwen3:14b', fellBack: true, requestedAt: 2_000, at: 2_000 };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listSessionInferenceMarks } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000);
    expect(listSessionInferenceMarks('s1').at(-1)?.at).toBe(new Date(1_000).toISOString());
  });

  it('marks nothing when the primary answers a chat that never fell back', async () => {
    latestServed = { slot: 'openrouter', modelId: 'x/primary', fellBack: false, requestedAt: 2_000, at: 2_000 };
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

describe('noteFallbackServed after a turn a pool answered', () => {
  const pool = (providerId: string, moved: string | null, at: number) => ({
    sessionKey: 's1',
    entryKey: 'confidential:qwen-3-8',
    slot: 'confidential',
    modelId: 'qwen-3-8',
    fellBack: false,
    pool: { providerId, moved },
    requestedAt: at,
    at,
  });

  beforeEach(async () => {
    resetHermesAgentsStoreForTests();
    latestServed = null;
    servedBySession = {};
    pendingMoves = {};
    mixedSessions.clear();
    const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
    setInferenceChainConfidential({
      poolSettings: () => DEFAULT_POOL_SETTINGS,
      poolStatus: async () => ({ serves: true, servesPrivate: true, contextLength: 32_768 }),
      providerLabel: (id: string) => (id === 'near' ? { name: 'NEAR AI', level: 'B' as const } : null),
    });
  });

  afterEach(async () => {
    servedBySession = {};
    latestServed = null;
    const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
    setInferenceChainConfidential(null);
  });

  it('records the provider’s catalog name and level, dated at the turn’s start, and nothing else', async () => {
    servedBySession = { s1: pool('near', 'new-session', 2_000) };
    const { getSessionInferenceSnapshot, noteFallbackServed } = await import('../sessionInference');
    noteFallbackServed('s1', 1_000, true, 900);
    const snapshot = await getSessionInferenceSnapshot('s1');
    expect(snapshot.poolTurns).toEqual([
      {
        at: new Date(1_000).toISOString(),
        windowStartedAt: new Date(900).toISOString(),
        modelId: 'qwen-3-8',
        providerId: 'near',
        providerName: 'NEAR AI',
        level: 'B',
        moved: 'new-session',
        mixedProviders: false,
      },
    ]);
    // A pool that served as the chain's first entry is not a fallback.
    expect(snapshot.marks).toEqual([]);
  });

  it('reads the chat’s own record before the latest answer for another chat', async () => {
    servedBySession = { s1: pool('near', null, 2_000) };
    latestServed = { slot: 'openrouter', modelId: 'x/other', fellBack: true, sessionKey: 's2', requestedAt: 3_000, at: 3_000 };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns, listSessionInferenceMarks } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true);
    expect(listPoolServedTurns('s1').map((turn) => turn.providerId)).toEqual(['near']);
    expect(listSessionInferenceMarks('s1')).toEqual([]);
  });

  it('keeps a move made by an earlier request of the turn, when the last one stayed', async () => {
    // Request 1 moved to Prem; requests 2..n stayed there and report no move.
    pendingMoves = { s1: 'rate-limited' };
    servedBySession = { s1: pool('near', null, 2_000) };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true);
    expect(listPoolServedTurns('s1').map((turn) => turn.moved)).toEqual(['rate-limited']);
    // Taken with the turn, so the next turn doesn't repeat it.
    servedBySession = { s1: pool('near', null, 4_000) };
    noteFallbackServed('s1', 3_000, true);
    expect(listPoolServedTurns('s1').map((turn) => turn.moved)).toEqual(['rate-limited', null]);
  });

  it('opens a window when a send reaches main and ends it when the turn ends; the pool record names it', async () => {
    servedBySession = { s1: pool('near', null, 2_000) };
    const { getSessionInferenceSnapshot, noteFallbackServed, noteTurnEnded, noteTurnStarted } = await import(
      '../sessionInference'
    );
    noteTurnStarted('s1', 900);
    noteFallbackServed('s1', 1_000, true, 900);
    noteTurnStarted('s1', 2_900);
    noteTurnEnded(['s1'], 900, 3_500);
    const snapshot = await getSessionInferenceSnapshot('s1');
    // Turn 2 began while turn 1 ran (a queued send) and is still running.
    expect(snapshot.turnWindows).toEqual([
      { startedAt: new Date(900).toISOString(), endedAt: new Date(3_500).toISOString() },
      { startedAt: new Date(2_900).toISOString(), endedAt: null },
    ]);
    expect(snapshot.poolTurns.map((turn) => turn.windowStartedAt)).toEqual([new Date(900).toISOString()]);
  });

  it('ends a window under the id the chat moved to during the turn', async () => {
    const { getSessionInferenceSnapshot, noteTurnEnded, noteTurnStarted } = await import('../sessionInference');
    const { migrateSessionInference } = await import('../hermesAgentStore');
    noteTurnStarted('runtime', 900);
    migrateSessionInference('runtime', 'revived');
    noteTurnEnded(['revived', 'runtime'], 900, 1_500);
    expect((await getSessionInferenceSnapshot('revived')).turnWindows).toEqual([
      { startedAt: new Date(900).toISOString(), endedAt: new Date(1_500).toISOString() },
    ]);
  });

  it('ends a window an earlier app run left open where the next window ends, or never', async () => {
    const { getSessionInferenceSnapshot } = await import('../sessionInference');
    const { appendSessionTurnWindow } = await import('../hermesAgentStore');
    const iso = (ms: number): string => new Date(ms).toISOString();
    appendSessionTurnWindow('s1', { startedAt: iso(900), endedAt: null, run: 'an-earlier-run' });
    expect((await getSessionInferenceSnapshot('s1')).turnWindows).toEqual([{ startedAt: iso(900), endedAt: null }]);
    appendSessionTurnWindow('s1', { startedAt: iso(2_000), endedAt: iso(3_000), run: 'an-earlier-run' });
    expect((await getSessionInferenceSnapshot('s1')).turnWindows).toEqual([
      { startedAt: iso(900), endedAt: iso(3_000) },
      { startedAt: iso(2_000), endedAt: iso(3_000) },
    ]);
  });

  it('ends an earlier run’s open window where the next turn that ran ends, past a send that never ran', async () => {
    const { getSessionInferenceSnapshot, noteTurnEnded, noteTurnStarted } = await import('../sessionInference');
    const { appendSessionTurnWindow } = await import('../hermesAgentStore');
    const iso = (ms: number): string => new Date(ms).toISOString();
    // The app quit mid-turn N; this run's N+1 never ran (its window closed at its start); N+2 ran.
    appendSessionTurnWindow('s1', { startedAt: iso(1_000), endedAt: null, run: 'an-earlier-run' });
    noteTurnStarted('s1', 20_000);
    noteTurnEnded(['s1'], 20_000, 20_000);
    noteTurnStarted('s1', 30_000);
    expect((await getSessionInferenceSnapshot('s1')).turnWindows[0]).toEqual({ startedAt: iso(1_000), endedAt: null });
    noteTurnEnded(['s1'], 30_000, 40_000);
    expect((await getSessionInferenceSnapshot('s1')).turnWindows).toEqual([
      { startedAt: iso(1_000), endedAt: iso(40_000) },
      { startedAt: iso(20_000), endedAt: iso(20_000) },
      { startedAt: iso(30_000), endedAt: iso(40_000) },
    ]);
  });

  it('writes no turn window while pools are off', async () => {
    const { setInferenceChainConfidential } = await import('../../../inference/inferenceChainService');
    const { noteTurnEnded, noteTurnStarted } = await import('../sessionInference');
    const { appendSessionTurnWindow, listSessionTurnWindows } = await import('../hermesAgentStore');
    setInferenceChainConfidential(null);
    noteTurnStarted('s1', 900);
    noteTurnEnded(['s1'], 900, 1_500);
    expect(listSessionTurnWindows('s1')).toEqual([]);
    // A window kept from when pools were on isn't ended either.
    appendSessionTurnWindow('s1', { startedAt: new Date(2_000).toISOString(), endedAt: null, run: 'r' });
    noteTurnEnded(['s1'], 2_000, 2_500);
    expect(listSessionTurnWindows('s1')).toEqual([{ startedAt: new Date(2_000).toISOString(), endedAt: null, run: 'r' }]);
  });

  it('says when more than one provider answered the turn, and only for that turn', async () => {
    mixedSessions.add('s1');
    servedBySession = { s1: pool('near', null, 2_000) };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true, 900);
    servedBySession = { s1: pool('near', null, 4_000) };
    noteFallbackServed('s1', 3_000, true, 2_900);
    expect(listPoolServedTurns('s1').map((turn) => turn.mixedProviders)).toEqual([true, false]);
  });

  it('takes the pool requests sent since the turn began, and ignores a record for one sent before', async () => {
    // The last turn's title request, sent before this turn began, answered after it began.
    servedBySession = { s1: { ...pool('near', null, 2_000), requestedAt: 900 } };
    takenSince.length = 0;
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true, 950);
    expect(takenSince).toEqual([['s1', 1_000]]);
    expect(listPoolServedTurns('s1')).toEqual([]);
  });

  it('records nothing from a pool answer without a session key', async () => {
    latestServed = { ...pool('near', null, 2_000), sessionKey: null };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true);
    expect(listPoolServedTurns('s1')).toEqual([]);
  });

  it('records nothing from a pool answer the router gave another chat', async () => {
    latestServed = { ...pool('near', null, 2_000), sessionKey: 's2' };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true);
    expect(listPoolServedTurns('s1')).toEqual([]);
  });

  it('records nothing for a turn the pool didn’t answer since it began', async () => {
    servedBySession = { s1: pool('near', null, 500) };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, false);
    expect(listPoolServedTurns('s1')).toEqual([]);
  });

  it('records nothing for a provider Boundary’s list no longer names', async () => {
    servedBySession = { s1: pool('gone', 'rate-limited', 2_000) };
    const { noteFallbackServed } = await import('../sessionInference');
    const { listPoolServedTurns } = await import('../hermesAgentStore');
    noteFallbackServed('s1', 1_000, true);
    expect(listPoolServedTurns('s1')).toEqual([]);
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
