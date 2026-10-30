import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceChainEntry, PeerModelRef } from '../../../../shared/types/inferenceChain';

const connections: Record<string, { endpointUrl: string; modelId: string; apiKey?: string } | null> = {};
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getSlotLlmConnection: async (slot: string) => connections[slot] ?? null,
  getAppDefaultSlot: () => 'local',
  getAppFallbacks: () => [],
}));
vi.mock('../../assistant/hermesProfileLimits', () => ({
  lookupModelContextLength: async () => 65_536,
}));

/** What the Circles running now say: joined Circles and each provider's available offer. */
const circles = {
  joined: new Set<string>(),
  offers: new Map<string, Record<string, { contextLength?: number }>>(),
  trusted: new Set<string>(),
  private: new Set<string>(),
};
vi.mock('../../circles/circlesService', () => ({
  sharedModelFacts: () => ({
    circleJoined: (circleId: string) => circles.joined.has(circleId),
    peerOffer: (peer: PeerModelRef) => circles.offers.get(`${peer.circleId}/${peer.providerId}`) ?? null,
    providerTrusted: (id: string) => circles.trusted.has(id),
    providerPrivate: (id: string) => circles.private.has(id),
  }),
}));

const { planInferenceChain } = await import('../inferenceChainService');

const PEER: PeerModelRef = { circleId: 'c'.repeat(64), providerId: 'a'.repeat(64) };
const shared = (modelId = 'qwen3-8b'): InferenceChainEntry => ({ slot: 'peer', modelId, peer: PEER });
const primary = { slot: 'openrouter' as const, modelId: 'anthropic/claude' };

beforeEach(() => {
  for (const key of Object.keys(connections)) delete connections[key];
  connections.openrouter = { endpointUrl: 'https://openrouter.ai/api/v1', modelId: 'anthropic/claude', apiKey: 'sk' };
  circles.joined = new Set([PEER.circleId]);
  circles.offers = new Map([[`${PEER.circleId}/${PEER.providerId}`, { 'qwen3-8b': { contextLength: 16_384 } }]]);
  circles.trusted = new Set([PEER.providerId]);
  circles.private = new Set();
});

describe('planInferenceChain with shared models', () => {
  it('routes a shared fallback through the Circles network, sized for it', async () => {
    const plan = await planInferenceChain(primary, [shared()]);
    expect(plan.kind).toBe('routed');
    if (plan.kind !== 'routed') return;
    const key = plan.chain.entries[1].key;
    expect(plan.chain.upstreams[key]).toEqual({ baseUrl: '', modelId: 'qwen3-8b', peer: PEER });
    // The smallest context in the chain is the shared model's, from its offer.
    expect(plan.chain.contextLength).toBe(16_384);
    // Sized like a local server: a member's own machine, maybe with a queue.
    expect(plan.slowestUrl).toBe('http://circle-peer');
    expect(plan.chain.entries[1]).toMatchObject({ stale: null, private: false });
  });

  it('marks a shared entry stale when the Circle is left, the offer is gone or the model isn’t offered', async () => {
    const cases: Array<[() => void, InferenceChainEntry, string]> = [
      [() => circles.joined.clear(), shared(), 'left-circle'],
      [() => circles.offers.clear(), shared(), 'offer-withdrawn'],
      [() => undefined, shared('llama-70b'), 'model-not-offered'],
      [() => circles.trusted.clear(), shared(), 'provider-untrusted'],
    ];
    for (const [arrange, entry, reason] of cases) {
      circles.trusted = new Set([PEER.providerId]);
      circles.joined = new Set([PEER.circleId]);
      circles.offers = new Map([[`${PEER.circleId}/${PEER.providerId}`, { 'qwen3-8b': {} }]]);
      arrange();
      // With the shared entry stale only one usable entry is left, so llm-proxy goes direct.
      expect(await planInferenceChain(primary, [entry])).toEqual({ kind: 'direct' });
      connections.local = { endpointUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen3:14b' };
      const plan = await planInferenceChain(primary, [entry, { slot: 'local' }]);
      expect(plan.kind === 'routed' && plan.chain.entries[1].stale).toBe(reason);
      expect(plan.kind === 'routed' && Object.keys(plan.chain.upstreams)).not.toContain(
        plan.kind === 'routed' ? plan.chain.entries[1].key : ''
      );
      delete connections.local;
    }
  });

  it('cuts a shared model out of a privacy-locked chain unless its provider is marked private', async () => {
    connections.local = { endpointUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen3:14b' };
    const lockedLocal = { slot: 'local' as const, modelId: 'qwen3:14b' };
    expect(await planInferenceChain(lockedLocal, [shared()], { privacyLocked: true })).toEqual({ kind: 'direct' });
    expect(await planInferenceChain(primary, [shared()], { privacyLocked: true })).toMatchObject({ kind: 'refused' });

    circles.private.add(PEER.providerId);
    const plan = await planInferenceChain(lockedLocal, [shared()], { privacyLocked: true });
    expect(plan.kind === 'routed' && plan.chain.entries.map((state) => state.private)).toEqual([true, true]);
  });
});
