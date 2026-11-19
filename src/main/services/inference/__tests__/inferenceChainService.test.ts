import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type TrustLevel } from '../../../../shared/types/confidential';
import type { PoolStatus } from '../confidential/confidentialService';
import type { PoolStop } from '../../../../shared/types/confidentialState';
import type { InferenceChainEntry, PeerModelRef } from '../../../../shared/types/inferenceChain';

let appShared: InferenceChainEntry | null = null;
let appFallbacks: InferenceChainEntry[] = [];
const connections: Record<string, { endpointUrl: string; modelId: string; apiKey?: string } | null> = {};
const slotReads: string[] = [];
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getSlotLlmConnection: async (slot: string) => {
    slotReads.push(slot);
    return connections[slot] ?? null;
  },
  getAppDefaultSlot: () => 'local',
  getAppFallbacks: () => appFallbacks,
  getAppSharedModel: () => appShared,
}));
const lookup = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock('../../assistant/hermesProfileLimits', () => ({
  lookupModelContextLength: async () => {
    if (lookup.delayMs) vi.setSystemTime(Date.now() + lookup.delayMs);
    return 65_536;
  },
}));
const diag = vi.hoisted(() => vi.fn());
vi.mock('../../circles/circlesDiagnostics', () => ({ diag, short: (key: string) => key.slice(0, 8) }));

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
  ensureCirclesStarted: async (): Promise<void> => undefined,
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

const { describeAppStack, planAppInferenceChain, planInferenceChain, setInferenceChainConfidential, sharedModelCantServe } =
  await import('../inferenceChainService');

const PEER: PeerModelRef = { circleId: 'c'.repeat(64), providerId: 'a'.repeat(64) };
const shared = (modelId = 'qwen3-8b'): InferenceChainEntry => ({ slot: 'peer', modelId, peer: PEER });
const primary = { slot: 'openrouter' as const, modelId: 'anthropic/claude' };

beforeEach(() => {
  for (const key of Object.keys(connections)) delete connections[key];
  connections.openrouter = { endpointUrl: 'https://openrouter.ai/api/v1', modelId: 'anthropic/claude', apiKey: 'sk' };
  appShared = null;
  appFallbacks = [];
  slotReads.length = 0;
  circles.running = true;
  circles.offline = new Set();
  circles.joined = new Set([PEER.circleId]);
  circles.offers = new Map([[`${PEER.circleId}/${PEER.providerId}`, { 'qwen3-8b': { contextLength: 16_384 } }]]);
  circles.trusted = new Set([PEER.providerId]);
  circles.private = new Set();
  lookup.delayMs = 0;
  diag.mockClear();
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

describe('the app stack for Inference', () => {
  it('lists the default slot, then its fallbacks, keyed as they are stored', async () => {
    connections.local = { endpointUrl: 'http://localhost:1234/v1', modelId: 'qwen3-32b' };
    appFallbacks = [shared(), { slot: 'openrouter' }];
    circles.private = new Set([PEER.providerId]);
    const stack = await describeAppStack();
    expect(stack.entries.map((state) => [state.key, state.stale, state.private, state.privateCut])).toEqual([
      ['local:', null, true, false],
      [`peer:${PEER.circleId}:${PEER.providerId}:qwen3-8b`, null, true, false],
      ['openrouter:', null, false, true],
    ]);
    expect(stack.contextLength).toBe(16_384);
    expect(stack.noPrivate).toBe(false);
  });

  it('marks a stale entry, and says when private projects can’t send', async () => {
    appShared = shared();
    appFallbacks = [{ slot: 'openrouter' }];
    circles.trusted = new Set();
    const stack = await describeAppStack();
    expect(stack.entries.map((state) => [state.stale, state.privateCut])).toEqual([
      ['provider-untrusted', true],
      [null, true],
    ]);
    expect(stack.noPrivate).toBe(true);
  });

  it('drops a fallback that resolves to an entry already listed', async () => {
    appFallbacks = [{ slot: 'openrouter', modelId: 'anthropic/claude' }];
    connections.local = { endpointUrl: 'http://localhost:1234/v1', modelId: 'qwen3-32b' };
    const stack = await describeAppStack();
    expect(stack.entries.map((state) => state.key)).toEqual(['local:', 'openrouter:anthropic/claude']);
  });
});

describe('a confidential pool in the chain', () => {
  const pool: InferenceChainEntry = { slot: 'confidential', modelId: 'qwen' };
  /** What the confidential service says now, and the floors it was asked about. */
  const pools = { status: { serves: true, servesPrivate: false, contextLength: 8_192 } as PoolStatus, floors: [] as TrustLevel[] };

  beforeEach(() => {
    pools.status = { serves: true, servesPrivate: false, contextLength: 8_192 };
    pools.floors = [];
    setInferenceChainConfidential({
      poolSettings: () => ({ ...DEFAULT_POOL_SETTINGS, privateFloor: 'A' }),
      poolStatus: async (_modelId: string, { projectFloor }: { projectFloor: TrustLevel }) => {
        pools.floors.push(projectFloor);
        return pools.status;
      },
    });
  });
  afterEach(() => setInferenceChainConfidential(null));

  it('is stale pool-no-provider with no confidential service, and leaves the local context alone', async () => {
    setInferenceChainConfidential(null);
    connections.local = { endpointUrl: 'http://localhost:1234/v1', modelId: 'qwen3-32b' };
    appFallbacks = [pool];
    const stack = await describeAppStack();
    expect(stack.entries.map((state) => [state.key, state.stale, state.private, state.contextLength])).toEqual([
      ['local:', null, true, 65_536],
      ['confidential:qwen', 'pool-no-provider', false, undefined],
    ]);
    expect(stack.contextLength).toBe(65_536);
    // A pool isn't a stored slot, so the store is never asked for it.
    expect(slotReads).not.toContain('confidential');
    expect(await planInferenceChain({ slot: 'local', modelId: 'qwen3-32b' }, [pool])).toEqual({ kind: 'direct' });
  });

  it('serves in the app stack with its context, judged at the private minimum', async () => {
    connections.local = { endpointUrl: 'http://localhost:1234/v1', modelId: 'qwen3-32b' };
    appFallbacks = [pool];
    const stack = await describeAppStack();
    expect(stack.entries.map((state) => [state.key, state.stale, state.private, state.contextLength])).toEqual([
      ['local:', null, true, 65_536],
      ['confidential:qwen', null, false, 8_192],
    ]);
    expect(stack.contextLength).toBe(8_192);
    expect(pools.floors).toEqual(['A']);
  });

  it('routes a one-entry pool chain', async () => {
    const plan = await planInferenceChain({ slot: 'confidential', modelId: 'qwen' }, []);
    expect(plan).toMatchObject({ kind: 'routed', slowestUrl: 'https://confidential-pool.invalid' });
    if (plan.kind !== 'routed') return;
    expect(plan.chain.modelId).toBe('qwen');
    expect(plan.chain.contextLength).toBe(8_192);
    expect(plan.chain.upstreams).toEqual({
      'confidential:qwen': { baseUrl: '', modelId: 'qwen', pool: { modelId: 'qwen', privateProject: false }, label: 'Confidential qwen' },
    });
  });

  it('routes when the pool is the only usable fallback', async () => {
    connections.local = { endpointUrl: 'http://localhost:1234/v1', modelId: 'qwen3-32b' };
    const plan = await planInferenceChain({ slot: 'local', modelId: 'qwen3-32b' }, [pool]);
    expect(plan.kind).toBe('routed');
    if (plan.kind !== 'routed') return;
    expect(Object.keys(plan.chain.upstreams)).toEqual(['local:qwen3-32b', 'confidential:qwen']);
    // Local is the slower of the two, so Hermes waits as long as for it.
    expect(plan.slowestUrl).toBe('http://localhost:1234/v1');
  });

  it('refuses a chain that starts with a pool nobody serves', async () => {
    pools.status = { serves: false, servesPrivate: false, contextLength: null };
    expect(await planInferenceChain({ slot: 'confidential', modelId: 'qwen' }, [])).toEqual({
      kind: 'refused',
      error: 'No added provider serves qwen now. Your message wasn’t sent. You can pick another model in Inference.',
    });
  });

  it('is kept in a private project when it serves private projects, with the project’s floor', async () => {
    pools.status = { serves: true, servesPrivate: true, contextLength: 8_192 };
    connections.local = { endpointUrl: 'http://localhost:1234/v1', modelId: 'qwen3-32b' };
    const plan = await planInferenceChain({ slot: 'local', modelId: 'qwen3-32b' }, [pool, { slot: 'openrouter' }], {
      privacyLocked: true,
      projectFloor: 'B',
    });
    expect(plan.kind).toBe('routed');
    if (plan.kind !== 'routed') return;
    expect(pools.floors).toEqual(['B']);
    expect(plan.chain.entries.map((state) => state.key)).toEqual(['local:qwen3-32b', 'confidential:qwen']);
    expect(plan.chain.upstreams['confidential:qwen']?.pool).toEqual({ modelId: 'qwen', privateProject: true, projectFloor: 'B' });
  });

  it('is cut in a private project when it doesn’t serve private projects, and the plan is refused as before', async () => {
    pools.status = { serves: true, servesPrivate: false, contextLength: 8_192 };
    expect(await planInferenceChain({ slot: 'confidential', modelId: 'qwen' }, [], { privacyLocked: true })).toEqual({
      kind: 'refused',
      privacy: true,
      error: 'This project is private and this chat’s model isn’t, so your message wasn’t sent.',
    });
    expect(pools.floors).toEqual(['A']);
  });

  it('says why each added provider misses a locked project’s floor when its pool can’t serve it', async () => {
    pools.status = { serves: true, servesPrivate: false, contextLength: 8_192 };
    const stop: PoolStop = {
      modelId: 'qwen',
      floor: 'A',
      lowestPrecision: 'fp8',
      providers: [
        { providerId: 'prem', name: 'Prem', level: 'B', precision: null, reason: 'below-level' },
        { providerId: 'near', name: 'NEAR AI Cloud', level: 'B', precision: 'fp8', reason: 'below-level' },
      ],
    };
    const privateStop = vi.fn(async (): Promise<PoolStop | null> => stop);
    setInferenceChainConfidential({
      poolSettings: () => ({ ...DEFAULT_POOL_SETTINGS, privateFloor: 'A' }),
      poolStatus: async () => pools.status,
      privateStop,
    });
    expect(await planInferenceChain(primary, [pool], { privacyLocked: true })).toEqual({
      kind: 'refused',
      privacy: true,
      error: 'This project is private and this chat’s model isn’t, so your message wasn’t sent.',
      poolStop: stop,
    });
    expect(privateStop).toHaveBeenCalledWith('qwen', { projectFloor: 'A' });

    // A provider qualifies, so the pool isn't why the send stops: the refusal says nothing about it.
    privateStop.mockResolvedValue(null);
    expect(await planInferenceChain(primary, [pool], { privacyLocked: true })).not.toHaveProperty('poolStop');
    // A chain that isn't locked never asks.
    privateStop.mockClear();
    await planInferenceChain(primary, [pool]);
    expect(privateStop).not.toHaveBeenCalled();
  });

  it('may become the app default only while a provider serves it', async () => {
    expect(await sharedModelCantServe(pool)).toBeNull();
    pools.status = { serves: false, servesPrivate: false, contextLength: null };
    expect(await sharedModelCantServe(pool)).toBe('No added provider serves qwen now.');
  });

  it('plans the app chain from a pool first', async () => {
    appShared = pool;
    const plan = await planAppInferenceChain();
    expect(plan).toMatchObject({ kind: 'routed', chain: { modelId: 'qwen' } });
  });
});

describe('a slow stack description', () => {
  it('logs each context lookup’s slot and time, and nothing for a quick one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await describeAppStack();
      expect(diag.mock.calls.some(([event]) => event === 'chain.describe-slow')).toBe(false);

      appFallbacks = [{ slot: 'openrouter' }];
      connections.local = { endpointUrl: 'http://192.168.1.20:1234/v1', modelId: 'qwen3-8b' };
      lookup.delayMs = 5_000;
      await describeAppStack();
      const slow = diag.mock.calls.find(([event]) => event === 'chain.describe-slow');
      expect(slow?.[1]).toEqual({
        ms: 10_000,
        entries: 2,
        lookups: [
          { slot: 'local', ms: 5_000, found: true },
          { slot: 'openrouter', ms: 5_000, found: true },
        ],
      });
      expect(JSON.stringify(slow)).not.toMatch(/192\.168|openrouter\.ai|qwen3|claude/);
    } finally {
      vi.useRealTimers();
    }
  });
});
