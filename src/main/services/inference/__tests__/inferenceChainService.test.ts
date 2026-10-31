import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceChainEntry, PeerModelRef } from '../../../../shared/types/inferenceChain';

let appShared: InferenceChainEntry | null = null;
let appFallbacks: InferenceChainEntry[] = [];
const connections: Record<string, { endpointUrl: string; modelId: string; apiKey?: string } | null> = {};
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getSlotLlmConnection: async (slot: string) => connections[slot] ?? null,
  getAppDefaultSlot: () => 'local',
  getAppFallbacks: () => appFallbacks,
  getAppSharedModel: () => appShared,
}));
vi.mock('../../assistant/hermesProfileLimits', () => ({
  lookupModelContextLength: async () => 65_536,
}));

/** What the Circles running now say: joined Circles and each provider's available offer. */
const circles = {
  running: true,
  offline: new Set<string>(),
  joined: new Set<string>(),
  offers: new Map<string, Record<string, { contextLength?: number }>>(),
  trusted: new Set<string>(),
  private: new Set<string>(),
};
vi.mock('../../circles/circlesService', () => ({
  ensureCirclesStarted: async () => undefined,
  sharedModelFacts: () => ({
    running: circles.running,
    identity: 'f'.repeat(64),
    providerName: () => 'Bo',
    providerOnline: (peer: PeerModelRef) => !circles.offline.has(peer.providerId),
    circleJoined: (circleId: string) => circles.joined.has(circleId),
    peerOffer: (peer: PeerModelRef) => circles.offers.get(`${peer.circleId}/${peer.providerId}`) ?? null,
    providerTrusted: (id: string) => circles.trusted.has(id),
    providerPrivate: (id: string) => circles.private.has(id),
  }),
}));

const { planAppInferenceChain, planInferenceChain, sharedModelCantServe } = await import('../inferenceChainService');

const PEER: PeerModelRef = { circleId: 'c'.repeat(64), providerId: 'a'.repeat(64) };
const shared = (modelId = 'qwen3-8b'): InferenceChainEntry => ({ slot: 'peer', modelId, peer: PEER });
const primary = { slot: 'openrouter' as const, modelId: 'anthropic/claude' };

beforeEach(() => {
  for (const key of Object.keys(connections)) delete connections[key];
  connections.openrouter = { endpointUrl: 'https://openrouter.ai/api/v1', modelId: 'anthropic/claude', apiKey: 'sk' };
  appShared = null;
  appFallbacks = [];
  circles.running = true;
  circles.offline = new Set();
  circles.joined = new Set([PEER.circleId]);
  circles.offers = new Map([[`${PEER.circleId}/${PEER.providerId}`, { 'qwen3-8b': { contextLength: 16_384 } }]]);
  circles.trusted = new Set([PEER.providerId]);
  circles.private = new Set();
});

describe('a chain that starts with a shared model (ADR 0036)', () => {
  const first = { slot: 'peer' as const, modelId: 'qwen3-8b', peer: PEER };

  it('routes one entry, because a shared model has no direct endpoint', async () => {
    const plan = await planInferenceChain(first, []);
    expect(plan).toMatchObject({ kind: 'routed', slowestUrl: 'http://circle-peer' });
    if (plan.kind !== 'routed') return;
    expect(plan.offline).toBeUndefined();
    expect(plan.chain.modelId).toBe('qwen3-8b');
    // Hermes's context comes from the offer.
    expect(plan.chain.contextLength).toBe(16_384);
  });

  it('refuses, naming the reason, when nothing can serve', async () => {
    const cases: Array<[() => void, RegExp]> = [
      [() => (circles.offers = new Map()), /Bo isn’t sharing qwen3-8b/],
      [() => (circles.offers = new Map([[`${PEER.circleId}/${PEER.providerId}`, { other: {} }]])), /Bo no longer shares/],
      [() => (circles.trusted = new Set()), /Turn on Trusted for Bo/],
      [() => (circles.joined = new Set()), /no longer in the Circle/],
      [() => { circles.joined = new Set(); circles.running = false; }, /Circles aren’t connected/],
    ];
    for (const [change, reason] of cases) {
      change();
      expect(await planInferenceChain(first, [])).toEqual({ kind: 'refused', error: expect.stringMatching(reason) });
      circles.running = true;
      circles.joined = new Set([PEER.circleId]);
      circles.trusted = new Set([PEER.providerId]);
      circles.offers = new Map([[`${PEER.circleId}/${PEER.providerId}`, { 'qwen3-8b': { contextLength: 16_384 } }]]);
    }
  });

  it('says so when the only member left is offline, and stays routed for an apply', async () => {
    circles.offline = new Set([PEER.providerId]);
    expect(await planInferenceChain(first, [])).toMatchObject({
      kind: 'routed',
      offline: expect.stringMatching(/Bo's qwen3-8b is offline/),
    });
  });

  it('falls to a connected provider when the shared model can’t serve, through the router', async () => {
    circles.trusted = new Set();
    const plan = await planInferenceChain(first, [{ slot: 'openrouter' }]);
    expect(plan.kind).toBe('routed');
    if (plan.kind !== 'routed') return;
    expect(plan.offline).toBeUndefined();
    expect(Object.keys(plan.chain.upstreams)).toEqual(['openrouter:']);
  });

  it('has no offline stop while a provider can answer instead, and skips the offline one', async () => {
    circles.offline = new Set([PEER.providerId]);
    const plan = await planInferenceChain(first, [{ slot: 'openrouter' }]);
    expect(plan).toMatchObject({ kind: 'routed' });
    if (plan.kind !== 'routed') return;
    expect(plan.offline).toBeFalsy();
    expect(Object.keys(plan.chain.upstreams)).toEqual(['openrouter:']);
    expect(plan.chain.entries[0].stale).toBe('provider-offline');
  });

  it('leaves the router when an offline fallback was all that made it a chain', async () => {
    circles.offline = new Set([PEER.providerId]);
    const fallback = { slot: 'peer' as const, modelId: 'qwen3-8b', peer: PEER };
    expect(await planInferenceChain({ slot: 'openrouter', modelId: 'm' }, [fallback])).toEqual({ kind: 'direct' });
  });

  it('keeps the privacy lock: refused unless the provider is marked private', async () => {
    expect((await planInferenceChain(first, [], { privacyLocked: true })).kind).toBe('refused');
    circles.private = new Set([PEER.providerId]);
    expect((await planInferenceChain(first, [], { privacyLocked: true })).kind).toBe('routed');
  });

  it('plans the app default when one is stored', async () => {
    appShared = shared();
    expect((await planAppInferenceChain()).kind).toBe('routed');
  });

  it('won’t take an untrusted model or the user’s own as the app default', async () => {
    expect(await sharedModelCantServe(shared())).toBeNull();
    circles.trusted = new Set();
    expect(await sharedModelCantServe(shared())).toMatch(/Turn on Trusted/);
    expect(await sharedModelCantServe({ ...shared(), peer: { ...PEER, providerId: 'f'.repeat(64) } })).toMatch(/your own/i);
  });
});

describe('planInferenceChain with shared models', () => {
  it('routes a shared fallback through the Circles network, sized for it', async () => {
    const plan = await planInferenceChain(primary, [shared()]);
    expect(plan.kind).toBe('routed');
    if (plan.kind !== 'routed') return;
    const key = plan.chain.entries[1].key;
    expect(plan.chain.upstreams[key]).toEqual({ baseUrl: '', modelId: 'qwen3-8b', peer: PEER, label: "Bo's qwen3-8b" });
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
