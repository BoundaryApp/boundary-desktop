import {
  DEFAULT_TURN_PROFILE,
  type CatalogOffer,
  type ModelPrice,
  type TurnProfile,
} from '../../../../shared/types/confidential';
import type { SpendCounts } from '../../../../shared/types/confidentialState';

/**
 * What a confidential provider charges now, and what one turn costs there (ADR 0047 §4–5).
 * A live price from the provider wins over the catalog, promo included, since the provider knows
 * when its promo ends. A live price with a rate that isn't finite and non-negative is ignored.
 * Without a live price, a catalog promo still running overrides the fields it names.
 */

function isRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isValidPrice(price: ModelPrice): boolean {
  return isRate(price.inputPerM) && isRate(price.outputPerM) && (price.cachedInputPerM === null || isRate(price.cachedInputPerM));
}

export function effectivePrice(offer: CatalogOffer, live: ModelPrice | undefined, now: number): ModelPrice | null {
  if (live && isValidPrice(live)) return live;
  if (!offer.price) return null;
  if (offer.promo && now < Date.parse(offer.promo.until)) return { ...offer.price, ...offer.promo.price };
  return offer.price;
}

/** USD for one turn. Cached tokens cost the input price when there's no cache discount. */
export function turnCost(price: ModelPrice, profile: TurnProfile = DEFAULT_TURN_PROFILE): number {
  const cachedTokens = profile.inputTokens * profile.cachedShare;
  const uncachedTokens = profile.inputTokens - cachedTokens;
  const cachedRate = price.cachedInputPerM ?? price.inputPerM;
  return (uncachedTokens * price.inputPerM + cachedTokens * cachedRate + profile.outputTokens * price.outputPerM) / 1e6;
}

/** A turn as one reply's OpenAI-style `usage` reports it; null when the counts are missing. */
export function observedTurn(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): TurnProfile | null {
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (!input || !output) return null;
  const cached = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, input);
  return { inputTokens: input, cachedShare: cached / input, outputTokens: output };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * The token counts of one reply's OpenAI-style `usage`; null when the input or output count is
 * missing or isn't a non-negative number, or when a cached count is present but invalid. A
 * missing or null cached count means none were cached.
 * Zero output tokens is a valid count. Cached tokens are capped at the input tokens.
 */
export function usageCounts(usage: unknown): SpendCounts | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: unknown };
  const inputTokens = count(u.prompt_tokens);
  const outputTokens = count(u.completion_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  let cachedTokens = 0;
  const details = u.prompt_tokens_details;
  const rawCached = typeof details === 'object' && details !== null ? (details as { cached_tokens?: unknown }).cached_tokens : null;
  // Some OpenAI-compatible providers send `cached_tokens: null` for no cached tokens.
  if (rawCached !== null && rawCached !== undefined) {
    const cached = count(rawCached);
    if (cached === null) return null;
    cachedTokens = Math.min(cached, inputTokens);
  }
  return { inputTokens, cachedTokens, outputTokens };
}

/** USD for the counts one reply reported. Cached tokens cost the input price when there's no cache discount. */
export function costOfCounts(price: ModelPrice, counts: SpendCounts): number {
  const cachedRate = price.cachedInputPerM ?? price.inputPerM;
  const uncached = counts.inputTokens - counts.cachedTokens;
  return (uncached * price.inputPerM + counts.cachedTokens * cachedRate + counts.outputTokens * price.outputPerM) / 1e6;
}
