import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POOL_SETTINGS,
  type CatalogOffer,
  type CatalogProvider,
  type ConfidentialCatalog,
  type ModelPrice,
  type PoolSettings,
} from '../../../../../shared/types/confidential';
import { choosePoolProvider, rankPool, type ProviderLiveState, type RankPoolInput } from '../pool';

const NOW = Date.parse('2026-11-08T12:00:00Z');

function offer(price: CatalogOffer['price'], overrides: Partial<CatalogOffer> = {}): CatalogOffer {
  return { providerModelId: 'm', precision: 'fp8', contextLength: 262_144, inputTypes: ['text', 'image'], price, ...overrides };
}

function provider(id: string, level: CatalogProvider['level'], offers: CatalogProvider['offers']): CatalogProvider {
  return { id, name: id, level, levelReason: 'fixture', keyUrl: 'https://example.com', billing: 'Prepaid', offers };
}

/** Prices from the prototype, read from the providers' pages on 2026-11-08. */
const catalog: ConfidentialCatalog = {
  format: 1,
  publishedAt: '2026-11-08T00:00:00Z',
  models: [
    { id: 'qwen', name: 'Qwen 3.8 27B' },
    { id: 'glmflash', name: 'GLM 5.3 Flash' },
  ],
  providers: [
    provider('prem', 'B', { qwen: offer({ inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 }, { precision: null }) }),
    provider('near', 'B', { qwen: offer({ inputPerM: 0.04, cachedInputPerM: null, outputPerM: 1.35 }) }),
    provider('chutes', 'C', { qwen: offer({ inputPerM: 0.039, cachedInputPerM: null, outputPerM: 1.25 }) }),
    provider('privatemode', 'A', { glmflash: offer({ inputPerM: 0.22, cachedInputPerM: null, outputPerM: 0.71 }, { precision: null }) }),
    provider('phala', 'C', { qwen: offer({ inputPerM: 0.2, cachedInputPerM: null, outputPerM: 2.5 }, { precision: null }) }),
  ],
};

function liveOk(overrides: Partial<ProviderLiveState> = {}): ProviderLiveState {
  return {
    balance: 10,
    rateLimitedUntil: null,
    attestation: 'passed',
    healthy: true,
    unhealthyUntil: null,
    keyUnavailable: false,
    toolsWork: true,
    medianTtfbMs: null,
    livePrices: {},
    ...overrides,
  };
}

function input(overrides: Partial<RankPoolInput> = {}, settings: Partial<PoolSettings> = {}): RankPoolInput {
  return {
    modelId: 'qwen',
    catalog,
    addedProviders: ['prem', 'near'],
    providers: { prem: liveOk(), near: liveOk(), chutes: liveOk(), phala: liveOk(), privatemode: liveOk() },
    settings: { ...DEFAULT_POOL_SETTINGS, ...settings },
    privateProject: false,
    request: { tools: true, inputTypes: ['text'] },
    now: NOW,
    ...overrides,
  };
}

const serving = (r: ReturnType<typeof rankPool>) => r.serving.map((c) => c.providerId);
const reason = (r: ReturnType<typeof rankPool>, id: string) => r.excluded.find((e) => e.providerId === id)?.reason;

describe('rankPool', () => {
  it('ranks added providers cheapest first', () => {
    const ranking = rankPool(input());
    expect(serving(ranking)).toEqual(['near', 'prem']);
    expect(ranking.serving[0].cost).toBeCloseTo(0.006375, 6);
    expect(ranking.floor).toBe('B');
  });

  it("excludes providers that aren't added with not-added", () => {
    expect(reason(rankPool(input()), 'chutes')).toBe('not-added');
  });

  it('leaves out providers that carry no offer for the model', () => {
    expect(rankPool(input()).excluded.map((e) => e.providerId)).not.toContain('privatemode');
  });

  it('uses the private floor and a project override', () => {
    const locked = rankPool(input({ privateProject: true }));
    expect(locked.floor).toBe('A');
    expect(serving(locked)).toEqual([]);
    expect(reason(locked, 'prem')).toBe('below-level');
    expect(reason(locked, 'near')).toBe('below-level');
    expect(serving(rankPool(input({ privateProject: true, projectFloor: 'B' })))).toEqual(['near', 'prem']);
  });

  it('reports one reason, the first in order', () => {
    const ranking = rankPool(input());
    expect(ranking.excluded.filter((e) => e.providerId === 'chutes')).toEqual([{ providerId: 'chutes', reason: 'not-added' }]);
  });

  it('applies the precision floor and the unstated switch', () => {
    expect(reason(rankPool(input({}, { lowestPrecision: 'bf16' })), 'near')).toBe('precision');
    expect(reason(rankPool(input({}, { allowUnstatedPrecision: false })), 'prem')).toBe('precision-unstated');
  });

  it('skips a provider without tools only when the request uses tools', () => {
    const providers = { ...input().providers, near: liveOk({ toolsWork: false }) };
    expect(reason(rankPool(input({ providers })), 'near')).toBe('no-tools');
    expect(serving(rankPool(input({ providers, request: { tools: false, inputTypes: ['text'] } })))).toEqual(['near', 'prem']);
    const untested = { ...input().providers, near: liveOk({ toolsWork: null }) };
    expect(serving(rankPool(input({ providers: untested })))).toContain('near');
  });

  it('excludes a provider whose context is too small for the request', () => {
    expect(reason(rankPool(input({ request: { tools: true, tokens: 300_000, inputTypes: ['text'] } })), 'near')).toBe('context');
  });

  it('excludes a provider that lacks an input type the request uses', () => {
    expect(reason(rankPool(input({ request: { tools: true, inputTypes: ['audio'] } })), 'near')).toBe('input-types');
  });

  it('excludes a provider whose key can’t be read, before its balance or health', () => {
    const near = liveOk({ keyUnavailable: true, balance: 0, healthy: false });
    expect(reason(rankPool(input({ providers: { ...input().providers, near } })), 'near')).toBe('key-unavailable');
  });

  it('excludes on balance 0, not on balance null', () => {
    expect(reason(rankPool(input({ providers: { ...input().providers, near: liveOk({ balance: 0 }) } })), 'near')).toBe('no-balance');
    expect(serving(rankPool(input({ providers: { ...input().providers, near: liveOk({ balance: null }) } })))).toContain('near');
  });

  it('excludes rate-limited until the time passes', () => {
    expect(reason(rankPool(input({ providers: { ...input().providers, near: liveOk({ rateLimitedUntil: NOW + 1 }) } })), 'near')).toBe(
      'rate-limited'
    );
    expect(serving(rankPool(input({ providers: { ...input().providers, near: liveOk({ rateLimitedUntil: NOW }) } })))).toContain('near');
  });

  it('excludes a failed attestation and lets unchecked through', () => {
    expect(reason(rankPool(input({ providers: { ...input().providers, near: liveOk({ attestation: 'failed' }) } })), 'near')).toBe(
      'attestation-failed'
    );
    expect(serving(rankPool(input({ providers: { ...input().providers, near: liveOk({ attestation: 'unchecked' }) } })))).toContain('near');
  });

  it('excludes an unhealthy provider, and an added provider with no live state', () => {
    expect(reason(rankPool(input({ providers: { ...input().providers, near: liveOk({ healthy: false }) } })), 'near')).toBe('unhealthy');
    const { near: _near, ...withoutNear } = input().providers;
    expect(reason(rankPool(input({ providers: withoutNear })), 'near')).toBe('unhealthy');
  });

  it('excludes a provider with no price as no-price', () => {
    const noPrice: ConfidentialCatalog = {
      ...catalog,
      providers: catalog.providers.map((p) => (p.id === 'near' ? { ...p, offers: { qwen: { ...p.offers.qwen, price: null } } } : p)),
    };
    expect(reason(rankPool(input({ catalog: noPrice })), 'near')).toBe('no-price');
  });

  it('uses a live price over the catalog', () => {
    const providers = { ...input().providers, prem: liveOk({ livePrices: { qwen: { inputPerM: 0.01, cachedInputPerM: 0, outputPerM: 0.1 } } }) };
    expect(serving(rankPool(input({ providers })))).toEqual(['prem', 'near']);
  });

  it('excludes a provider whose only price is a bad live price, and never sorts it first', () => {
    const noCatalogPrice: ConfidentialCatalog = {
      ...catalog,
      providers: catalog.providers.map((p) => (p.id === 'near' ? { ...p, offers: { qwen: { ...p.offers.qwen, price: null } } } : p)),
    };
    const providers = { ...input().providers, near: liveOk({ livePrices: { qwen: { inputPerM: Number.NaN, cachedInputPerM: null, outputPerM: 1 } } }) };
    const ranking = rankPool(input({ catalog: noCatalogPrice, providers }));
    expect(reason(ranking, 'near')).toBe('no-price');
    expect(serving(ranking)).toEqual(['prem']);
  });

  it("breaks a cost tie on latency, then on the user's order", () => {
    const same: ModelPrice = { inputPerM: 0.1, cachedInputPerM: null, outputPerM: 1 };
    const tied = {
      ...input().providers,
      prem: liveOk({ livePrices: { qwen: same } }),
      near: liveOk({ livePrices: { qwen: same } }),
    };
    expect(serving(rankPool(input({ providers: tied })))).toEqual(['prem', 'near']);
    expect(serving(rankPool(input({ providers: tied, addedProviders: ['near', 'prem'] })))).toEqual(['near', 'prem']);
    const faster = { ...tied, prem: liveOk({ livePrices: { qwen: same }, medianTtfbMs: 900 }), near: liveOk({ livePrices: { qwen: same }, medianTtfbMs: 300 }) };
    expect(serving(rankPool(input({ providers: faster })))).toEqual(['near', 'prem']);
    const oneKnown = { ...tied, prem: liveOk({ livePrices: { qwen: same }, medianTtfbMs: 900 }) };
    expect(serving(rankPool(input({ providers: oneKnown })))).toEqual(['prem', 'near']);
  });

  it('returns no serving providers when all are excluded', () => {
    const ranking = rankPool(input({ addedProviders: [] }));
    expect(ranking.serving).toEqual([]);
    expect(ranking.excluded.every((e) => e.reason === 'not-added')).toBe(true);
  });
});

describe('choosePoolProvider', () => {
  const settings = DEFAULT_POOL_SETTINGS;
  const prefer = { ...DEFAULT_POOL_SETTINGS, preferOneProvider: true };

  /** A ranking with two serving providers at the given costs, cheapest first. */
  function ranking(cheap: [string, number], dear: [string, number]): ReturnType<typeof rankPool> {
    const base = rankPool(input());
    const pick = (id: string, cost: number) => ({ ...base.serving[0], providerId: id, cost });
    return { ...base, serving: [pick(...cheap), pick(...dear)] };
  }

  it('keeps a session on its sticky provider even when another is cheaper', () => {
    expect(choosePoolProvider(rankPool(input()), { settings, stickyProviderId: 'prem' })).toEqual({ providerId: 'prem', why: 'sticky' });
  });

  it('moves a session whose sticky provider is now rate-limited to the cheapest', () => {
    const limited = rankPool(input({ providers: { ...input().providers, near: liveOk({ rateLimitedUntil: NOW + 60_000 }) } }));
    expect(choosePoolProvider(limited, { settings, stickyProviderId: 'near' })).toEqual({ providerId: 'prem', why: 'cheapest' });
  });

  it('keeps the preferred provider within the threshold', () => {
    expect(choosePoolProvider(ranking(['near', 0.0085], ['prem', 0.01]), { settings: prefer, preferredProviderId: 'prem' })).toEqual({
      providerId: 'prem',
      why: 'preferred',
    });
  });

  it('leaves the preferred provider past the threshold', () => {
    expect(choosePoolProvider(ranking(['near', 0.0079], ['prem', 0.01]), { settings: prefer, preferredProviderId: 'prem' })).toEqual({
      providerId: 'near',
      why: 'cheapest',
    });
  });

  it('ignores the preferred provider when Prefer one provider is off', () => {
    expect(choosePoolProvider(ranking(['near', 0.0085], ['prem', 0.01]), { settings, preferredProviderId: 'prem' })).toEqual({
      providerId: 'near',
      why: 'cheapest',
    });
  });

  it('falls back to the cheapest when the preferred provider is not serving', () => {
    expect(choosePoolProvider(rankPool(input()), { settings: prefer, preferredProviderId: 'chutes' })).toEqual({
      providerId: 'near',
      why: 'cheapest',
    });
  });

  it('returns null with nothing serving', () => {
    expect(choosePoolProvider(rankPool(input({ addedProviders: [] })), { settings, stickyProviderId: 'near' })).toBeNull();
  });
});
