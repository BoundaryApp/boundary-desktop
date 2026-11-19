import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainRouterOptions, RouterChain, RouterServed } from '../router/chainRouter';
import type { PoolSender } from '../confidential/poolSender';
import type { PoolMoveReason } from '../../../../shared/types/confidential';

const started = vi.hoisted(() => ({ options: null as ChainRouterOptions | null }));

vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));
vi.mock('../../circles/circlesDiagnostics', () => ({ diag: vi.fn() }));
vi.mock('../../circles/circlesService', () => ({ fetchSharedModel: vi.fn() }));
vi.mock('../router/chainRouter', () => ({
  startChainRouter: vi.fn(async (options: ChainRouterOptions) => {
    started.options = options;
    return { port: 4321, close: async (): Promise<void> => undefined };
  }),
}));

const service = await import('../inferenceRouterService');

function served(sessionKey: string | null, entryKey: string): RouterServed {
  return { sessionKey, entryKey, slot: 'local', modelId: 'm', fellBack: false, requestedAt: 0, at: 0 };
}

afterEach(async () => {
  service.setInferenceRouterPoolSender(null);
  await service.stopInferenceRouter();
});

describe('inference router service', () => {
  it('keeps the latest answer per session beside the latest overall', async () => {
    await service.ensureInferenceRouter();
    started.options!.onServed!(served('s1', 'local'));
    started.options!.onServed!(served('s2', 'cloud'));
    started.options!.onServed!(served(null, 'peer'));
    expect(service.latestInferenceRouterServed()?.entryKey).toBe('peer');
    expect(service.latestInferenceRouterServed('s1')?.entryKey).toBe('local');
    expect(service.latestInferenceRouterServed('s2')?.entryKey).toBe('cloud');
    expect(service.latestInferenceRouterServed('s3')).toBeNull();
  });

  it('keeps a session’s last pool move until it is taken, through later requests that stay', async () => {
    await service.ensureInferenceRouter();
    const pool = (moved: PoolMoveReason | null): RouterServed => ({
      ...served('s1', 'confidential:qwen'),
      pool: { providerId: 'b', moved },
    });
    started.options!.onServed!(pool('rate-limited'));
    started.options!.onServed!(pool(null));
    started.options!.onServed!({ ...served('s2', 'local') });
    expect(service.latestInferenceRouterServed('s1')?.pool?.moved).toBeNull();
    expect(service.takeInferenceRouterPoolTurn('s1', 0)).toEqual({ moved: 'rate-limited', mixedProviders: false });
    expect(service.takeInferenceRouterPoolTurn('s1', 0)).toEqual({ moved: null, mixedProviders: false });
    expect(service.takeInferenceRouterPoolTurn('s2', 0)).toEqual({ moved: null, mixedProviders: false });
  });

  it('says a turn was served by more than one pool provider until it is taken', async () => {
    await service.ensureInferenceRouter();
    const pool = (providerId: string): RouterServed => ({
      ...served('s1', 'confidential:qwen'),
      pool: { providerId, moved: null },
    });
    started.options!.onServed!(pool('a'));
    started.options!.onServed!(pool('a'));
    expect(service.takeInferenceRouterPoolTurn('s1', 0).mixedProviders).toBe(false);
    started.options!.onServed!(pool('a'));
    started.options!.onServed!(pool('b'));
    expect(service.takeInferenceRouterPoolTurn('s1', 0).mixedProviders).toBe(true);
    // Taken with the turn, so the next turn starts clean.
    started.options!.onServed!(pool('b'));
    expect(service.takeInferenceRouterPoolTurn('s1', 0).mixedProviders).toBe(false);
  });

  it('says a turn split between a pool and another entry was served by more than one provider', async () => {
    await service.ensureInferenceRouter();
    const pool: RouterServed = { ...served('s1', 'confidential:qwen'), pool: { providerId: 'a', moved: null } };
    started.options!.onServed!(served('s1', 'local:m'));
    started.options!.onServed!(pool);
    expect(service.takeInferenceRouterPoolTurn('s1', 0).mixedProviders).toBe(true);
    started.options!.onServed!(pool);
    started.options!.onServed!(served('s1', 'local:m'));
    expect(service.takeInferenceRouterPoolTurn('s1', 0).mixedProviders).toBe(true);
    // Only other entries, or only the one pool provider: not mixed.
    started.options!.onServed!(served('s1', 'local:m'));
    started.options!.onServed!(served('s1', 'local:m'));
    expect(service.takeInferenceRouterPoolTurn('s1', 0).mixedProviders).toBe(false);
  });

  it('leaves out of a turn the requests sent before it began, such as the last turn’s title', async () => {
    await service.ensureInferenceRouter();
    const pool = (providerId: string, requestedAt: number, moved: PoolMoveReason | null = null): RouterServed => ({
      ...served('s1', 'confidential:qwen'),
      pool: { providerId, moved },
      requestedAt,
      at: requestedAt + 10,
    });
    // Turn 1 ended and was taken; Hermes then titled the chat through another entry.
    started.options!.onServed!({ ...served('s1', 'openrouter:x'), requestedAt: 1_500, at: 1_600 });
    started.options!.onServed!(pool('b', 1_700, 'rate-limited'));
    // Turn 2 began at 2_000 and stayed on provider a.
    started.options!.onServed!(pool('a', 2_100));
    started.options!.onServed!(pool('a', 2_200));
    expect(service.takeInferenceRouterPoolTurn('s1', 2_000)).toEqual({ moved: null, mixedProviders: false });
    // Taking clears the earlier requests too.
    expect(service.takeInferenceRouterPoolTurn('s1', 0)).toEqual({ moved: null, mixedProviders: false });
  });

  it('keeps the session’s latest request as its record, when an earlier one answers last', async () => {
    await service.ensureInferenceRouter();
    started.options!.onServed!({ ...served('s1', 'local'), requestedAt: 2_100, at: 2_200 });
    // A title request sent before the turn, whose answer's head came later.
    started.options!.onServed!({ ...served('s1', 'openrouter:x'), requestedAt: 1_900, at: 2_300 });
    expect(service.latestInferenceRouterServed('s1')?.entryKey).toBe('local');
  });

  it('drops the oldest session past 500', async () => {
    await service.ensureInferenceRouter();
    for (let i = 0; i < 501; i++) started.options!.onServed!(served(`s${i}`, 'local'));
    expect(service.latestInferenceRouterServed('s0')).toBeNull();
    expect(service.latestInferenceRouterServed('s1')?.entryKey).toBe('local');
    expect(service.latestInferenceRouterServed('s500')?.entryKey).toBe('local');
  });

  it('forgets every session when the router stops', async () => {
    await service.ensureInferenceRouter();
    started.options!.onServed!(served('s1', 'local'));
    await service.stopInferenceRouter();
    expect(service.latestInferenceRouterServed('s1')).toBeNull();
    expect(service.latestInferenceRouterServed()).toBeNull();
  });

  it('sends pool entries to the current sender, and finds them unreachable without one', async () => {
    await service.ensureInferenceRouter();
    const pool = { modelId: 'llama-3.3-70b', privateProject: true, projectFloor: 'A' as const };
    const signal = new AbortController().signal;
    expect(await started.options!.poolFetch!(pool, {}, signal, { sessionKey: 's1' })).toEqual({
      ok: false,
      outcome: { kind: 'unreachable' },
    });

    const send = vi.fn<PoolSender['send']>(async () => ({ ok: false, outcome: { kind: 'status', status: 400 } }));
    service.setInferenceRouterPoolSender({ send });
    const body: Record<string, unknown> = { messages: [], tools: [{ type: 'function' }] };
    await started.options!.poolFetch!(pool, body, signal, { sessionKey: 's1', requestTokens: 12 });
    expect(send).toHaveBeenCalledWith('llama-3.3-70b', body, signal, {
      sessionKey: 's1',
      privateProject: true,
      projectFloor: 'A',
      requestTokens: 12,
      tools: true,
    });
    await started.options!.poolFetch!({ modelId: 'm', privateProject: false }, { tools: [] }, signal, { sessionKey: null });
    expect(send).toHaveBeenLastCalledWith('m', { tools: [] }, signal, { sessionKey: null, privateProject: false, tools: false });
  });

  describe('once chains', () => {
    const chainTo = (modelId: string): RouterChain => ({
      entries: [{ entry: { slot: 'local' }, key: modelId, stale: null, private: true }],
      upstreams: { [modelId]: { baseUrl: `http://${modelId}.test/v1`, modelId } },
      modelId,
    });
    const applied = chainTo('applied');
    const own = chainTo('own');

    it('serves a registered chain only to requests carrying its key', async () => {
      await service.ensureInferenceRouter();
      service.setInferenceRouterChain(applied);
      const release = service.routeOnce('once-1', own);
      expect(started.options!.getChain('once-1')).toBe(own);
      expect(started.options!.getChain('s1')).toBe(applied);
      expect(started.options!.getChain(null)).toBe(applied);
      // The applied chain can still change under it.
      const next = chainTo('next');
      service.setInferenceRouterChain(next);
      expect(started.options!.getChain('s1')).toBe(next);
      expect(started.options!.getChain('once-1')).toBe(own);
      expect(service.inferenceRouterChain()).toBe(next);
      release();
    });

    it('releasing removes the chain and its served records', async () => {
      await service.ensureInferenceRouter();
      service.setInferenceRouterChain(applied);
      const release = service.routeOnce('once-1', own);
      started.options!.onServed!({ ...served('once-1', 'own'), pool: { providerId: 'a', moved: 'rate-limited' } });
      expect(service.latestInferenceRouterServed('once-1')?.entryKey).toBe('own');
      release();
      expect(started.options!.getChain('once-1')).toBe(applied);
      expect(service.latestInferenceRouterServed('once-1')).toBeNull();
      expect(service.takeInferenceRouterPoolTurn('once-1', 0)).toEqual({ moved: null, mixedProviders: false });
      // A second release changes nothing, even after the key is used again.
      const again = service.routeOnce('once-1', own);
      release();
      expect(started.options!.getChain('once-1')).toBe(own);
      again();
    });

    it('keeps a once answer out of the latest answer a chat without a key falls back to', async () => {
      await service.ensureInferenceRouter();
      started.options!.onServed!(served(null, 'peer'));
      const release = service.routeOnce('once-1', own);
      started.options!.onServed!(served('once-1', 'own'));
      expect(service.latestInferenceRouterServed()?.entryKey).toBe('peer');
      release();
    });

    it('records nothing for a once key answered after its release', async () => {
      await service.ensureInferenceRouter();
      started.options!.onServed!(served(null, 'peer'));
      service.routeOnce('once-1', own)();
      started.options!.onServed!({ ...served('once-1', 'own'), pool: { providerId: 'a', moved: 'rate-limited' } });
      expect(service.latestInferenceRouterServed()?.entryKey).toBe('peer');
      expect(service.latestInferenceRouterServed('once-1')).toBeNull();
      expect(service.takeInferenceRouterPoolTurn('once-1', 0)).toEqual({ moved: null, mixedProviders: false });
    });

    it('forgets once chains when the router stops', async () => {
      await service.ensureInferenceRouter();
      service.routeOnce('once-1', own);
      await service.stopInferenceRouter();
      await service.ensureInferenceRouter();
      expect(started.options!.getChain('once-1')).toBeNull();
    });
  });
});
