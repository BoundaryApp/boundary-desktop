/**
 * Confidential providers and pools (ADR 0047): Boundary's signed provider catalog, the user's
 * pool settings and the turn a cost estimate assumes.
 */

/** What Boundary's adapter checks on the user's Mac (ADR 0047 §6). A is highest. */
export type TrustLevel = 'A' | 'B' | 'C';

/** Why a chat's pool moved to the provider that served it (ADR 0047 §8). */
export type PoolMoveReason =
  | 'new-session'
  | 'rate-limited'
  | 'no-balance'
  | 'bad-key'
  | 'unreachable'
  | 'attestation-failed'
  | 'server'
  | 'stopped-serving';

/** Weight precision a provider serves a model at. Higher keeps more of the model's quality. */
export type Precision = 'bf16' | 'fp8' | 'fp4';

export type InputType = 'text' | 'image' | 'video' | 'audio';

/** USD per million tokens. A null cached price means no cache discount. */
export interface ModelPrice {
  inputPerM: number;
  cachedInputPerM: number | null;
  outputPerM: number;
}

/** A price that applies until `until` (ISO date-time), over the fields it names. */
export interface PricePromo {
  price: Partial<ModelPrice>;
  until: string;
}

/** One provider's copy of a canonical model. */
export interface CatalogOffer {
  providerModelId: string;
  /** Null when the provider doesn't state it. */
  precision: Precision | null;
  contextLength: number;
  inputTypes: InputType[];
  /** Null when the provider reports prices through its own API instead. */
  price: ModelPrice | null;
  promo?: PricePromo;
}

export interface CatalogProvider {
  id: string;
  name: string;
  level: TrustLevel;
  /** Why the provider has its level, including facts outside the levels (ADR 0047 §6). */
  levelReason: string;
  keyUrl: string;
  billing: string;
  /** Something to know before adding it, shown on the key step and in its details. */
  note?: string;
  /** Where its hardware runs, when the list says. */
  runsIn?: string;
  /**
   * SHA-256 (lowercase hex) of each attestation manifest the adapter may accept, over the exact
   * bytes the provider serves. Set for providers whose reference values come from a manifest
   * Boundary fetches (Privatemode); the adapter refuses any other manifest.
   */
  manifestSha256?: string[];
  /** Keyed by canonical model id. */
  offers: Record<string, CatalogOffer>;
}

export interface CanonicalModel {
  id: string;
  name: string;
}

export interface ConfidentialCatalog {
  format: 1;
  publishedAt: string;
  models: CanonicalModel[];
  providers: CatalogProvider[];
}

export interface PoolSettings {
  chatFloor: TrustLevel;
  privateFloor: TrustLevel;
  lowestPrecision: Precision;
  allowUnstatedPrecision: boolean;
  preferOneProvider: boolean;
  preferThresholdPercent: 10 | 20 | 50;
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  chatFloor: 'B',
  privateFloor: 'A',
  lowestPrecision: 'fp8',
  allowUnstatedPrecision: true,
  preferOneProvider: false,
  preferThresholdPercent: 20,
};

/** The tokens one turn sends and receives, for a cost estimate. */
export interface TurnProfile {
  inputTokens: number;
  /** Share of input tokens served from the provider's cache, 0 to 1. */
  cachedShare: number;
  outputTokens: number;
}

/** A typical agent turn before a session has usage of its own (confidential inference spec decision 6). */
export const DEFAULT_TURN_PROFILE: TurnProfile = { inputTokens: 75_000, cachedShare: 0.6, outputTokens: 2_500 };

const LEVEL_RANK: Record<TrustLevel, number> = { A: 3, B: 2, C: 1 };
const PRECISION_RANK: Record<Precision, number> = { bf16: 3, fp8: 2, fp4: 1 };

/** True when `level` is `floor` or higher. */
export function meetsLevel(level: TrustLevel, floor: TrustLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[floor];
}

/**
 * The lowest provider level a private project's pool requests may reach: B when the project
 * allows level B (confidential inference spec decision 10), else Pool settings' private minimum.
 */
export function projectConfidentialFloor(
  pin: import('./hermesChat').ProjectInferencePin | undefined,
  settings: PoolSettings
): TrustLevel {
  return pin?.allowConfidentialLevelB === true ? 'B' : settings.privateFloor;
}

/** True when `precision` is `lowest` or higher. */
export function meetsPrecision(precision: Precision, lowest: Precision): boolean {
  return PRECISION_RANK[precision] >= PRECISION_RANK[lowest];
}
