import { describe, expect, it } from 'vitest';
import { parseCatalog } from '../catalog';

type Json = Record<string, unknown>;

function offer(overrides: Json = {}): Json {
  return {
    providerModelId: 'qwen38-27b',
    precision: null,
    contextLength: 262_144,
    inputTypes: ['text'],
    price: { inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 },
    ...overrides,
  };
}

function provider(overrides: Json = {}): Json {
  return {
    id: 'prem',
    name: 'Prem',
    level: 'B',
    levelReason: 'Hardware checked; build not pinned.',
    keyUrl: 'https://dashboard.prem.io/api-keys',
    billing: 'Prepaid by card',
    offers: { qwen: offer(), dsflash: offer({ providerModelId: 'deepseek-v4.1-flash-1017' }) },
    ...overrides,
  };
}

function catalogFixture(overrides: Json = {}): Json {
  return {
    format: 1,
    publishedAt: '2026-11-08T00:00:00Z',
    models: [
      { id: 'qwen', name: 'Qwen 3.8 27B' },
      { id: 'dsflash', name: 'DeepSeek V4.1 Flash' },
    ],
    providers: [provider()],
    ...overrides,
  };
}

function withPremOffers(offers: Json): Json {
  return catalogFixture({ providers: [provider({ offers })] });
}

describe('parseCatalog', () => {
  it('accepts a valid catalog', () => {
    const result = parseCatalog(catalogFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dropped).toEqual([]);
    expect(result.catalog.providers[0].offers.qwen).toEqual(offer());
    expect(result.catalog.models).toHaveLength(2);
  });

  it('rejects a wrong format', () => {
    expect(parseCatalog(catalogFixture({ format: 2 })).ok).toBe(false);
  });

  it('rejects a bad publishedAt', () => {
    expect(parseCatalog(catalogFixture({ publishedAt: 'yesterday' })).ok).toBe(false);
  });

  it('rejects a value that is not an object', () => {
    expect(parseCatalog(null).ok).toBe(false);
    expect(parseCatalog([]).ok).toBe(false);
  });

  it("drops an offer with a negative price and keeps the provider's other offers", () => {
    const result = parseCatalog(
      withPremOffers({ qwen: offer(), dsflash: offer({ price: { inputPerM: -1, cachedInputPerM: null, outputPerM: 1 } }) })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dropped).toEqual([{ providerId: 'prem', modelId: 'dsflash', reason: expect.stringContaining('price') }]);
    expect(Object.keys(result.catalog.providers[0].offers)).toEqual(['qwen']);
  });

  it('drops an offer with a NaN output price', () => {
    const result = parseCatalog(
      withPremOffers({ qwen: offer({ price: { inputPerM: 0.3, cachedInputPerM: null, outputPerM: Number.NaN } }) })
    );
    expect(result.ok && result.dropped.map((drop) => drop.modelId)).toEqual(['qwen']);
  });

  it("drops an offer for a model the catalog doesn't list", () => {
    const result = parseCatalog(withPremOffers({ qwen: offer(), kimi: offer() }));
    expect(result.ok && result.dropped).toEqual([{ providerId: 'prem', modelId: 'kimi', reason: expect.any(String) }]);
  });

  it('drops an offer with a bad context length, precision or input type', () => {
    const result = parseCatalog(
      withPremOffers({
        qwen: offer({ contextLength: 0 }),
        dsflash: offer({ precision: 'int3', inputTypes: ['smell'] }),
      })
    );
    expect(result.ok && result.dropped.map((drop) => drop.modelId)).toEqual(['qwen', 'dsflash']);
  });

  it("drops a provider with level 'D'", () => {
    const result = parseCatalog(catalogFixture({ providers: [provider({ level: 'D' }), provider({ id: 'near', name: 'NEAR AI' })] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dropped).toEqual([{ providerId: 'prem', reason: expect.any(String) }]);
    expect(result.catalog.providers.map((p) => p.id)).toEqual(['near']);
  });

  it('keeps a note and runsIn, and leaves them out when absent', () => {
    const result = parseCatalog(
      catalogFixture({
        providers: [provider({ note: 'Beta service.', runsIn: 'Switzerland' }), provider({ id: 'near', name: 'NEAR AI' })],
      })
    );
    expect(result.ok && result.dropped).toEqual([]);
    if (!result.ok) return;
    expect(result.catalog.providers[0]).toMatchObject({ note: 'Beta service.', runsIn: 'Switzerland' });
    expect('note' in result.catalog.providers[1]).toBe(false);
    expect('runsIn' in result.catalog.providers[1]).toBe(false);
  });

  it('drops a provider whose note or runsIn is present but not text', () => {
    const result = parseCatalog(
      catalogFixture({
        providers: [provider({ note: '' }), provider({ id: 'near', name: 'NEAR AI', runsIn: 3 }), provider({ id: 'chutes', name: 'Chutes' })],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dropped.map((drop) => drop.providerId)).toEqual(['prem', 'near']);
    expect(result.catalog.providers.map((p) => p.id)).toEqual(['chutes']);
  });

  it('keeps the first of two providers with the same id', () => {
    const result = parseCatalog(catalogFixture({ providers: [provider(), provider({ name: 'Prem again' })] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.providers.map((p) => p.name)).toEqual(['Prem']);
    expect(result.dropped).toEqual([{ providerId: 'prem', reason: expect.stringContaining('duplicate') }]);
  });

  it('accepts price null and keeps a promo', () => {
    const promo = { price: { cachedInputPerM: 0 }, until: '2026-12-01T00:00:00Z' };
    const result = parseCatalog(withPremOffers({ qwen: offer({ price: null, promo }) }));
    expect(result.ok && result.dropped).toEqual([]);
    expect(result.ok && result.catalog.providers[0].offers.qwen.price).toBeNull();
    expect(result.ok && result.catalog.providers[0].offers.qwen.promo).toEqual(promo);
  });

  it('drops an offer whose promo has a bad until', () => {
    const result = parseCatalog(withPremOffers({ qwen: offer({ promo: { price: { inputPerM: 0 }, until: 'soon' } }) }));
    expect(result.ok && result.dropped.map((drop) => drop.modelId)).toEqual(['qwen']);
  });
});
