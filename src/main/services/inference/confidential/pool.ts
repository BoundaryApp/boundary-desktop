import {
  meetsLevel,
  meetsPrecision,
  type CatalogOffer,
  type ConfidentialCatalog,
  type InputType,
  type ModelPrice,
  type PoolSettings,
  type TrustLevel,
  type TurnProfile,
} from '../../../../shared/types/confidential';
import type { ConfidentialLiveView, PoolExclusion, PoolRanking } from '../../../../shared/types/confidentialState';
import { effectivePrice, turnCost } from './prices';

/**
 * Which providers serve a confidential pool, cheapest first, and why the others don't
 * (ADR 0047 §5–7; confidential inference spec decision 5). Each excluded provider gets one
 * reason: the first that applies, in the order of `PoolExclusion`.
 */

/** What Boundary knows about an added provider now; the renderer sees the same shape. */
export type ProviderLiveState = ConfidentialLiveView;

export interface PoolRequest {
  tools: boolean;
  /** Estimated prompt tokens, when known. */
  tokens?: number;
  inputTypes: InputType[];
}

export interface RankPoolInput {
  modelId: string;
  catalog: ConfidentialCatalog;
  /** In the user's order. */
  addedProviders: string[];
  providers: Record<string, ProviderLiveState>;
  settings: PoolSettings;
  privateProject: boolean;
  /** A private project's own floor, when it allows a lower level (spec decision 10). */
  projectFloor?: TrustLevel;
  request: PoolRequest;
  profile?: TurnProfile;
  now: number;
}

function exclusion(
  input: RankPoolInput,
  floor: TrustLevel,
  providerId: string,
  level: TrustLevel,
  offer: CatalogOffer,
  price: ModelPrice | null
): PoolExclusion | null {
  const { settings, request, now } = input;
  if (!input.addedProviders.includes(providerId)) return 'not-added';
  if (!meetsLevel(level, floor)) return 'below-level';
  if (offer.precision !== null && !meetsPrecision(offer.precision, settings.lowestPrecision)) return 'precision';
  if (offer.precision === null && !settings.allowUnstatedPrecision) return 'precision-unstated';
  if (!price) return 'no-price';
  const live = input.providers[providerId];
  if (!live) return 'unhealthy';
  if (request.tools && live.toolsWork === false) return 'no-tools';
  if (request.tokens !== undefined && request.tokens > offer.contextLength) return 'context';
  if (!request.inputTypes.every((type) => offer.inputTypes.includes(type))) return 'input-types';
  if (live.keyUnavailable) return 'key-unavailable';
  if (live.balance !== null && live.balance <= 0) return 'no-balance';
  if (live.rateLimitedUntil !== null && live.rateLimitedUntil > now) return 'rate-limited';
  if (live.attestation === 'failed') return 'attestation-failed';
  if (!live.healthy || (live.unhealthyUntil !== null && live.unhealthyUntil > now)) return 'unhealthy';
  return null;
}

export function rankPool(input: RankPoolInput): PoolRanking {
  const floor = input.privateProject ? (input.projectFloor ?? input.settings.privateFloor) : input.settings.chatFloor;
  const serving: PoolRanking['serving'] = [];
  const excluded: PoolRanking['excluded'] = [];
  for (const provider of input.catalog.providers) {
    const offer = provider.offers[input.modelId];
    if (!offer) continue;
    const price = effectivePrice(offer, input.providers[provider.id]?.livePrices[input.modelId], input.now);
    const reason = exclusion(input, floor, provider.id, provider.level, offer, price);
    const cost = price ? turnCost(price, input.profile) : Number.NaN;
    // A cost that isn't finite would make the sort inconsistent, so it counts as no price.
    if (reason || !price || !Number.isFinite(cost)) excluded.push({ providerId: provider.id, reason: reason ?? 'no-price' });
    else serving.push({ providerId: provider.id, offer, price, cost });
  }
  const latency = (id: string) => input.providers[id]?.medianTtfbMs ?? Number.POSITIVE_INFINITY;
  const order = (id: string) => input.addedProviders.indexOf(id);
  serving.sort(
    (a, b) =>
      a.cost - b.cost || latency(a.providerId) - latency(b.providerId) || order(a.providerId) - order(b.providerId)
  );
  return { floor, serving, excluded };
}

export interface PoolChoice {
  providerId: string;
  why: 'sticky' | 'preferred' | 'cheapest';
}

/**
 * The provider a session uses (ADR 0047 §8–9). A session stays on the provider that served it
 * while that provider can still serve, so its cache isn't lost. With Prefer one provider on,
 * the preferred provider keeps new sessions unless another is cheaper by more than the threshold.
 */
export function choosePoolProvider(
  ranking: PoolRanking,
  opts: { settings: PoolSettings; stickyProviderId?: string | null; preferredProviderId?: string | null }
): PoolChoice | null {
  const cheapest = ranking.serving[0];
  if (!cheapest) return null;
  const find = (id: string | null | undefined) => (id ? ranking.serving.find((c) => c.providerId === id) : undefined);
  const sticky = find(opts.stickyProviderId);
  if (sticky) return { providerId: sticky.providerId, why: 'sticky' };
  const preferred = opts.settings.preferOneProvider ? find(opts.preferredProviderId) : undefined;
  if (preferred && !(cheapest.cost < preferred.cost * (1 - opts.settings.preferThresholdPercent / 100))) {
    return { providerId: preferred.providerId, why: 'preferred' };
  }
  return { providerId: cheapest.providerId, why: 'cheapest' };
}
