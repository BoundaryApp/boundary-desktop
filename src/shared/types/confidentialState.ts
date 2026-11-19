import type { CanonicalModel, CatalogOffer, ModelPrice, PoolSettings, Precision, TrustLevel } from './confidential';
import type { SecretPreview } from './secrets';

/**
 * What the confidential pool tells the renderer (ADR 0047 phase 3). Never holds an API key;
 * `keyPreview` is the masked form.
 */

/** What Boundary knows about an added provider now. */
export interface ConfidentialLiveView {
  /** USD; null when the provider can't report it. */
  balance: number | null;
  rateLimitedUntil: number | null;
  /** `unchecked` passes: the adapter checks at session start. */
  attestation: 'passed' | 'failed' | 'unchecked';
  healthy: boolean;
  /** A send failed with a provider error; the provider counts as unhealthy until this time. */
  unhealthyUntil: number | null;
  /** The stored key couldn't be decrypted at the last refresh, so the key needs entering again. */
  keyUnavailable: boolean;
  /** From the test tool call when the provider was added; null until tested. */
  toolsWork: boolean | null;
  medianTtfbMs: number | null;
  /** Keyed by canonical model id. */
  livePrices: Record<string, ModelPrice>;
}

/**
 * One model at a provider. `price` is the provider's live price when it's added and reports one,
 * else the catalog price with any running promo; `turnCost` is USD for the default turn.
 */
interface ConfidentialOfferView {
  modelId: string;
  precision: Precision | null;
  price: ModelPrice | null;
  turnCost: number | null;
}

export interface ConfidentialProviderView {
  id: string;
  name: string;
  level: TrustLevel;
  levelReason: string;
  keyUrl: string;
  billing: string;
  note?: string;
  runsIn?: string;
  /** Canonical model ids the provider serves, in catalog order. */
  models: string[];
  /** Each model's copy there, in the same order, priced as a pool would price it now. */
  offers: ConfidentialOfferView[];
  added: boolean;
  keyPreview: SecretPreview | null;
  live: ConfidentialLiveView | null;
  problem: 'key-unavailable' | 'rate-limited' | 'no-balance' | 'attestation-failed' | 'unhealthy' | null;
}

export type ConfidentialState =
  | { enabled: false }
  | {
      enabled: true;
      catalog: { available: boolean; publishedAt: string | null; stale: boolean; signatureFailed: boolean };
      models: CanonicalModel[];
      providers: ConfidentialProviderView[];
      settings: PoolSettings;
    };

export type AddProviderCheck = { step: 'key' | 'attestation' | 'models' | 'tools'; ok: boolean; detail: string };

export type AddProviderResult = { added: boolean; checks: AddProviderCheck[] };

/** Why a provider doesn't serve a pool; the first reason that applies, in this order. */
export type PoolExclusion =
  | 'not-added'
  | 'below-level'
  | 'precision'
  | 'precision-unstated'
  | 'no-price'
  | 'no-tools'
  | 'context'
  | 'input-types'
  | 'key-unavailable'
  | 'no-balance'
  | 'rate-limited'
  | 'attestation-failed'
  | 'unhealthy'
  /** Only in a private project's stop: an added provider that doesn't offer the model at all. */
  | 'model-not-offered';

interface PoolCandidate {
  providerId: string;
  offer: CatalogOffer;
  price: ModelPrice;
  cost: number;
}

export interface PoolRanking {
  floor: TrustLevel;
  serving: PoolCandidate[];
  excluded: { providerId: string; reason: PoolExclusion }[];
}

/**
 * Why a private project's send stopped at a pool: no added provider qualifies at the project's
 * floor (confidential inference spec decision 10). Each added provider is listed with its first
 * exclusion, or `model-not-offered` when it doesn't carry the model. Ids, names, levels and
 * reasons only; never a key.
 */
export interface PoolStop {
  modelId: string;
  floor: TrustLevel;
  /** Pool settings' lowest precision, for a `precision` reason's sentence. */
  lowestPrecision: Precision;
  providers: Array<{
    providerId: string;
    name: string;
    level: TrustLevel;
    /** The offer's precision, for a `precision` reason's sentence. */
    precision: Precision | null;
    reason: PoolExclusion;
  }>;
}

/** Token counts one reply reported. */
export interface SpendCounts {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** One turn a confidential pool answered. Metadata only: no session, chat, text or error detail. */
export interface SpendEntry {
  /** Epoch ms when the turn ended. */
  at: number;
  providerId: string;
  /** Canonical model id. */
  modelId: string;
  /** Null when the reply carried no usage object. */
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  /** Estimated USD at the price the ranking used; null when the counts are missing. */
  cost: number | null;
}

export interface ConfidentialSpendRow {
  providerId: string;
  name: string;
  level: TrustLevel;
  turns: number;
  turnsWithoutCounts: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  balance: number | null;
  removed: boolean;
}

/** Turns over the last 30 days, per provider. */
export interface ConfidentialSpend {
  since: number;
  rows: ConfidentialSpendRow[];
  totalTurns: number;
  totalCost: number;
}
