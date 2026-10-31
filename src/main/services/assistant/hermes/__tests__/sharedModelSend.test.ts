import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerModelRef } from '../../../../../shared/types/inferenceChain';
import { clearLastAppliedLlm, setLastAppliedLlm } from '../../AssistantStackStore';
import {
  clearOpenAiConfig,
  saveLlmConnection,
  setAppDefault,
  setAppFallbacks,
  setAppSharedModel,
} from '../../../onboarding/OpenAiOnboardingStore';
import { resetHermesAgentsStoreForTests } from '../hermesAgentStore';
import { resetRunningTurnsForTests } from '../hermesRunningTurns';

const applyLlmConnectionToHermes = vi.fn();
vi.mock('../../AssistantStackService', () => ({
  applyLlmConnectionToHermes: (...args: unknown[]) => applyLlmConnectionToHermes(...args),
  settleHermesApply: async () => undefined,
}));

let routerPushed = false;
const setInferenceRouterChain = vi.fn();
vi.mock('../../../inference/inferenceRouterService', () => ({
  inferenceRouterPushed: () => routerPushed,
  setInferenceRouterChain: (...args: unknown[]) => setInferenceRouterChain(...args),
}));

const circles = { offered: true, trusted: true, online: true, private: false };
vi.mock('../../../circles/circlesService', () => ({
  ensureCirclesStarted: async () => undefined,
  sharedModelFacts: () => ({
    running: true,
    identity: 'a'.repeat(64),
    providerName: (_peer: PeerModelRef) => 'Bo',
    providerOnline: () => circles.online,
    circleJoined: () => true,
    peerOffer: () => (circles.offered ? { 'qwen3-8b': { contextLength: 16_384 } } : null),
    providerTrusted: () => circles.trusted,
    providerPrivate: () => circles.private,
  }),
}));

let localStack = false;
vi.mock('../../localStackMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../localStackMode')>()),
  isLocalAssistantStackMode: () => localStack,
}));

let project: { inference: { mode: 'inherit'; privacyLocalOnly: boolean } } | null = null;
vi.mock('../hermesProjectStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesProjectStore')>()),
  getActiveHermesProjectId: () => (project ? 'p1' : null),
  getStoredHermesProject: () => project,
}));
vi.mock('../hermesChatProjects', () => ({ conversationProjectId: () => (project ? 'p1' : null) }));

const probeSlotHealth = vi.fn();
vi.mock('../../../onboarding/probeSlotHealth', () => ({
  probeSlotHealth: (...args: unknown[]) => probeSlotHealth(...args),
}));

const { ensureResolvedInferenceReady } = await import('../sessionInference');
const { resolveSessionInference } = await import('../resolveSessionInference');

const peer = { circleId: 'c'.repeat(64), providerId: 'b'.repeat(64) };

/** With no provider connected: the shared model is all there is. */
describe('sending with a shared model as the app default (ADR 0036)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await clearOpenAiConfig();
    resetHermesAgentsStoreForTests();
    clearLastAppliedLlm();
    resetRunningTurnsForTests();
    Object.assign(circles, { offered: true, trusted: true, online: true, private: false });
    routerPushed = false;
    localStack = false;
    project = null;
    applyLlmConnectionToHermes.mockResolvedValue({ success: true });
    probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
    await setAppSharedModel({ slot: 'peer', modelId: 'qwen3-8b', peer });
  });

  it('resolves naming the shared model', async () => {
    expect(await resolveSessionInference('s1')).toMatchObject({
      slot: 'peer',
      modelId: 'qwen3-8b',
      peer,
      providerDisplayName: "Bo's qwen3-8b",
      provenance: 'app-default',
      configured: true,
    });
  });

  it('applies the routed chain the first time', async () => {
    const onRestarting = vi.fn();
    expect((await ensureResolvedInferenceReady('s1', onRestarting)).ok).toBe(true);
    expect(onRestarting).toHaveBeenCalledOnce();
    expect(applyLlmConnectionToHermes).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'peer', modelId: 'qwen3-8b', plan: expect.objectContaining({ kind: 'routed' }) }),
      expect.anything()
    );
  });

  it('only pushes the chain once the proxy already points at the router', async () => {
    routerPushed = true;
    setLastAppliedLlm({
      slot: 'peer',
      endpointUrl: 'http://circle-peer',
      modelId: 'qwen3-8b',
      contextLength: 16_384,
      routed: true,
      appliedAt: '2026-10-30T00:00:00.000Z',
    });
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
    expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
    expect(setInferenceRouterChain).toHaveBeenCalledOnce();
  });

  it.each([
    ['paused', () => (circles.offered = false), /Bo isn’t sharing qwen3-8b/],
    ['untrusted', () => (circles.trusted = false), /Turn on Trusted for Bo/],
    ['offline', () => (circles.online = false), /Bo's qwen3-8b is offline/],
  ])('stops the send and says why when %s, naming no provider', async (_name, change, reason) => {
    change();
    const result = await ensureResolvedInferenceReady('s1');
    expect(result).toEqual({ ok: false, error: expect.stringMatching(reason), errorCode: 'apply-failed' });
    expect(JSON.stringify(result)).not.toMatch(/OpenRouter/);
    expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
  });

  it('refuses in a privacy-locked project unless the provider is private', async () => {
    project = { inference: { mode: 'inherit', privacyLocalOnly: true } };
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(false);
    circles.private = true;
    expect((await ensureResolvedInferenceReady('s1')).ok).toBe(true);
  });

  it('refuses in local-stack mode, which never routes', async () => {
    localStack = true;
    const result = await ensureResolvedInferenceReady('s1');
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/local-stack mode/) });
  });

  describe('with OpenRouter in the chain and the provider offline', () => {
    const openRouter = {
      endpointUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-key',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
    } as const;
    const shared = { slot: 'peer', modelId: 'qwen3-8b', peer } as const;

    async function openRouterThenShared() {
      await clearOpenAiConfig();
      await saveLlmConnection(openRouter);
      await setAppDefault('openrouter');
      expect((await setAppFallbacks([shared])).success).toBe(true);
      setLastAppliedLlm({
        slot: 'openrouter',
        endpointUrl: openRouter.endpointUrl,
        modelId: openRouter.modelId,
        routed: true,
        appliedAt: '2026-10-30T00:00:00.000Z',
      });
      routerPushed = true;
      circles.online = false;
    }

    it('refuses the apply a chain going direct would need, naming both', async () => {
      await openRouterThenShared();
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
      const onApply = vi.fn();
      expect(await ensureResolvedInferenceReady('s1', onApply)).toEqual({
        ok: false,
        error: 'Your shared model isn’t available and OpenRouter didn’t answer, so your message wasn’t sent.',
        errorCode: 'provider-unreachable',
        sharedUnavailable: true,
      });
      expect(onApply).not.toHaveBeenCalled();
      expect(applyLlmConnectionToHermes).not.toHaveBeenCalled();
    });

    it('applies when OpenRouter answers, saying the shared model isn’t available', async () => {
      await openRouterThenShared();
      const onApply = vi.fn();
      expect((await ensureResolvedInferenceReady('s1', onApply)).ok).toBe(true);
      expect(onApply).toHaveBeenCalledWith(expect.anything(), true, false);
      expect(applyLlmConnectionToHermes).toHaveBeenCalledOnce();
    });

    it('checks a direct send while the chain’s member is away, though it needs no apply', async () => {
      await openRouterThenShared();
      setLastAppliedLlm({
        slot: 'openrouter',
        endpointUrl: openRouter.endpointUrl,
        modelId: openRouter.modelId,
        appliedAt: '2026-10-30T00:00:00.000Z',
      });
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
      expect(await ensureResolvedInferenceReady('s1')).toMatchObject({ errorCode: 'provider-unreachable' });
    });

    it('checks a chain that starts with the member, which needs no apply to lose them', async () => {
      await saveLlmConnection(openRouter);
      expect((await setAppFallbacks([{ slot: 'openrouter' }])).success).toBe(true);
      routerPushed = true;
      circles.online = false;
      setLastAppliedLlm({
        slot: 'peer',
        endpointUrl: 'http://circle-peer',
        modelId: 'qwen3-8b',
        contextLength: 16_384,
        routed: true,
        appliedAt: '2026-10-30T00:00:00.000Z',
      });
      probeSlotHealth.mockResolvedValue({ success: true, health: 'unreachable' });
      expect(await ensureResolvedInferenceReady('s1')).toMatchObject({
        errorCode: 'provider-unreachable',
        sharedUnavailable: true,
      });
      expect(setInferenceRouterChain).not.toHaveBeenCalled();
    });

    it('probes nothing on an ordinary chained send with the member online', async () => {
      await openRouterThenShared();
      circles.online = true;
      setLastAppliedLlm({
        slot: 'openrouter',
        endpointUrl: openRouter.endpointUrl,
        modelId: openRouter.modelId,
        contextLength: 16_384,
        routed: true,
        appliedAt: '2026-10-30T00:00:00.000Z',
      });
      await ensureResolvedInferenceReady('s1');
      expect(probeSlotHealth).not.toHaveBeenCalled();
    });
  });
});
