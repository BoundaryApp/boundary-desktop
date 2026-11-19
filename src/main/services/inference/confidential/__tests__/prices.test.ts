import { describe, expect, it } from 'vitest';
import type { CatalogOffer, ModelPrice } from '../../../../../shared/types/confidential';
import { costOfCounts, effectivePrice, observedTurn, turnCost, usageCounts } from '../prices';

const near: ModelPrice = { inputPerM: 0.04, cachedInputPerM: null, outputPerM: 1.35 };
const prem: ModelPrice = { inputPerM: 0.3, cachedInputPerM: 0, outputPerM: 2.4 };

function offer(overrides: Partial<CatalogOffer> = {}): CatalogOffer {
  return { providerModelId: 'qwen38-27b', precision: null, contextLength: 262_144, inputTypes: ['text'], price: prem, ...overrides };
}

describe('turnCost', () => {
  it('costs a default turn', () => {
    expect(turnCost(near)).toBeCloseTo(0.006375, 6); // 75k × 0.04 + 2.5k × 1.35, per million
    expect(turnCost(prem)).toBeCloseTo(0.015, 6); // 30k × 0.30 + 45k × 0 + 2.5k × 2.40
  });

  it('uses a given profile', () => {
    expect(turnCost(prem, { inputTokens: 10_000, cachedShare: 0, outputTokens: 1_000 })).toBeCloseTo(0.0054, 6);
  });
});

describe('effectivePrice', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');

  it('prefers a live price over the catalog', () => {
    expect(effectivePrice(offer(), near, now)).toEqual(near);
  });

  it('applies a promo before its until and not after', () => {
    const promoted = offer({
      price: { ...prem, cachedInputPerM: 0.03 },
      promo: { price: { cachedInputPerM: 0 }, until: '2026-12-01T00:00:00Z' },
    });
    expect(effectivePrice(promoted, undefined, Date.parse('2026-11-30T23:59:59Z'))?.cachedInputPerM).toBe(0);
    expect(effectivePrice(promoted, undefined, Date.parse('2026-12-01T00:00:00Z'))?.cachedInputPerM).toBe(0.03);
  });

  it("doesn't apply a catalog promo over a live price", () => {
    const promoted = offer({ promo: { price: { inputPerM: 0 }, until: '2026-12-01T00:00:00Z' } });
    expect(effectivePrice(promoted, near, now)).toEqual(near);
  });

  it('ignores a live price that is NaN, infinite or negative', () => {
    expect(effectivePrice(offer(), { ...near, inputPerM: Number.NaN }, now)).toEqual(prem);
    expect(effectivePrice(offer(), { ...near, outputPerM: -1 }, now)).toEqual(prem);
    expect(effectivePrice(offer(), { ...near, cachedInputPerM: Number.POSITIVE_INFINITY }, now)).toEqual(prem);
    expect(effectivePrice(offer({ price: null }), { ...near, outputPerM: Number.NaN }, now)).toBeNull();
  });

  it('returns null with no price anywhere', () => {
    expect(effectivePrice(offer({ price: null }), undefined, now)).toBeNull();
  });
});

describe('observedTurn', () => {
  it('reads a turn from usage', () => {
    expect(
      observedTurn({ prompt_tokens: 40_000, completion_tokens: 1_000, prompt_tokens_details: { cached_tokens: 30_000 } })
    ).toEqual({ inputTokens: 40_000, cachedShare: 0.75, outputTokens: 1_000 });
    expect(observedTurn({ prompt_tokens: 40_000, completion_tokens: 1_000 })).toEqual({
      inputTokens: 40_000,
      cachedShare: 0,
      outputTokens: 1_000,
    });
    expect(observedTurn({ completion_tokens: 10 })).toBeNull();
    expect(observedTurn({ prompt_tokens: 0, completion_tokens: 10 })).toBeNull();
  });
});

describe('usageCounts', () => {
  it('reads input, cached and output tokens', () => {
    expect(
      usageCounts({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } })
    ).toEqual({ inputTokens: 1000, cachedTokens: 600, outputTokens: 20 });
  });

  it('treats missing details as no cached tokens', () => {
    expect(usageCounts({ prompt_tokens: 10, completion_tokens: 5 })?.cachedTokens).toBe(0);
  });

  it('treats a null or missing cached count as no cached tokens', () => {
    expect(usageCounts({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: null } })?.cachedTokens).toBe(0);
    expect(usageCounts({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: undefined } })?.cachedTokens).toBe(0);
    expect(usageCounts({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: {} })?.cachedTokens).toBe(0);
    expect(usageCounts({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: null })?.cachedTokens).toBe(0);
  });

  it('caps cached tokens at the input tokens', () => {
    expect(
      usageCounts({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 5000 } })?.cachedTokens
    ).toBe(1000);
  });

  it('accepts zero output tokens', () => {
    expect(usageCounts({ prompt_tokens: 10, completion_tokens: 0 })).toEqual({
      inputTokens: 10,
      cachedTokens: 0,
      outputTokens: 0,
    });
  });

  it('rejects malformed usage', () => {
    const bad: unknown[] = [
      null,
      {},
      { prompt_tokens: -1, completion_tokens: 5 },
      { prompt_tokens: '10', completion_tokens: 5 },
      { prompt_tokens: Number.NaN, completion_tokens: 5 },
      { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: -3 } },
      { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: '3' } },
      { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY } },
    ];
    for (const usage of bad) expect(usageCounts(usage)).toBeNull();
  });
});

describe('costOfCounts', () => {
  const counts = { inputTokens: 1000, cachedTokens: 600, outputTokens: 20 };

  it('prices uncached, cached and output tokens', () => {
    expect(costOfCounts({ inputPerM: 0.2, cachedInputPerM: 0.05, outputPerM: 0.8 }, counts)).toBeCloseTo(0.000126, 9);
  });

  it('charges cached tokens the input price without a cache discount', () => {
    expect(costOfCounts({ inputPerM: 0.2, cachedInputPerM: null, outputPerM: 0.8 }, counts)).toBeCloseTo(
      (1000 * 0.2 + 20 * 0.8) / 1e6,
      9
    );
  });
});
