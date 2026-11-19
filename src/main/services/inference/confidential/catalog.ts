import type {
  CanonicalModel,
  CatalogOffer,
  CatalogProvider,
  ConfidentialCatalog,
  InputType,
  ModelPrice,
  Precision,
  PricePromo,
  TrustLevel,
} from '../../../../shared/types/confidential';

/**
 * Boundary's confidential provider catalog (ADR 0047 §3–4). The catalog is checked field by
 * field: a bad offer or provider is dropped and reported, so one mistake in the published list
 * doesn't take every pool down. A bad top level rejects the whole catalog.
 */

/** An offer or provider left out of a catalog, and why. */
export interface CatalogDrop {
  providerId: string;
  modelId?: string;
  reason: string;
}

export type CatalogParseResult =
  | { ok: true; catalog: ConfidentialCatalog; dropped: CatalogDrop[] }
  | { ok: false; error: string };

const LEVELS: readonly TrustLevel[] = ['A', 'B', 'C'];
const PRECISIONS: readonly Precision[] = ['bf16', 'fp8', 'fp4'];
const INPUT_TYPES: readonly InputType[] = ['text', 'image', 'video', 'audio'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseModel(value: unknown): CanonicalModel | null {
  if (!isRecord(value) || !isText(value.id) || !isText(value.name)) return null;
  return { id: value.id, name: value.name };
}

function parsePrice(value: unknown): ModelPrice | string {
  if (!isRecord(value)) return 'price is not an object';
  const { inputPerM, cachedInputPerM, outputPerM } = value;
  if (!isRate(inputPerM) || !isRate(outputPerM)) return 'price needs non-negative input and output rates';
  if (cachedInputPerM === null) return { inputPerM, cachedInputPerM: null, outputPerM };
  if (!isRate(cachedInputPerM)) return 'cached price must be a non-negative rate or null';
  return { inputPerM, cachedInputPerM, outputPerM };
}

function parsePromo(value: unknown): PricePromo | string {
  if (!isRecord(value) || !isRecord(value.price) || !isDate(value.until)) return 'promo needs a price and a valid until';
  const price: Partial<ModelPrice> = {};
  for (const key of ['inputPerM', 'cachedInputPerM', 'outputPerM'] as const) {
    if (!(key in value.price)) continue;
    const rate = value.price[key];
    if (!isRate(rate)) return `promo ${key} must be a non-negative rate`;
    price[key] = rate;
  }
  return { price, until: value.until };
}

function parseOffer(value: unknown): CatalogOffer | string {
  if (!isRecord(value)) return 'offer is not an object';
  if (!isText(value.providerModelId)) return 'offer needs a providerModelId';
  const { contextLength, precision, inputTypes } = value;
  if (typeof contextLength !== 'number' || !Number.isInteger(contextLength) || contextLength <= 0) {
    return 'contextLength must be a positive integer';
  }
  if (precision !== null && !PRECISIONS.includes(precision as Precision)) return 'unknown precision';
  if (!Array.isArray(inputTypes) || inputTypes.length === 0 || !inputTypes.every((t) => INPUT_TYPES.includes(t as InputType))) {
    return 'unknown input type';
  }
  let price: ModelPrice | null = null;
  if (value.price !== null) {
    const parsed = parsePrice(value.price);
    if (typeof parsed === 'string') return parsed;
    price = parsed;
  }
  const offer: CatalogOffer = {
    providerModelId: value.providerModelId,
    precision: precision as Precision | null,
    contextLength,
    inputTypes: inputTypes as InputType[],
    price,
  };
  if (value.promo !== undefined) {
    const promo = parsePromo(value.promo);
    if (typeof promo === 'string') return promo;
    offer.promo = promo;
  }
  return offer;
}

function parseProvider(
  value: unknown,
  modelIds: Set<string>,
  dropped: CatalogDrop[]
): CatalogProvider | null {
  const id = isRecord(value) && isText(value.id) ? value.id : '(no id)';
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isText(value.name) ||
    !LEVELS.includes(value.level as TrustLevel) ||
    !isText(value.levelReason) ||
    !isText(value.keyUrl) ||
    !isText(value.billing) ||
    !isRecord(value.offers)
  ) {
    dropped.push({ providerId: id, reason: 'provider needs id, name, level A–C, levelReason, keyUrl, billing and offers' });
    return null;
  }
  if ((value.note !== undefined && !isText(value.note)) || (value.runsIn !== undefined && !isText(value.runsIn))) {
    dropped.push({ providerId: id, reason: 'note and runsIn must be text when present' });
    return null;
  }
  const offers: Record<string, CatalogOffer> = {};
  for (const [modelId, raw] of Object.entries(value.offers)) {
    if (!modelIds.has(modelId)) {
      dropped.push({ providerId: id, modelId, reason: 'model is not in the catalog' });
      continue;
    }
    const offer = parseOffer(raw);
    if (typeof offer === 'string') dropped.push({ providerId: id, modelId, reason: offer });
    else offers[modelId] = offer;
  }
  return {
    id: value.id,
    name: value.name,
    level: value.level as TrustLevel,
    levelReason: value.levelReason,
    keyUrl: value.keyUrl,
    billing: value.billing,
    ...(value.note === undefined ? {} : { note: value.note as string }),
    ...(value.runsIn === undefined ? {} : { runsIn: value.runsIn as string }),
    offers,
  };
}

export function parseCatalog(value: unknown): CatalogParseResult {
  if (!isRecord(value)) return { ok: false, error: 'catalog is not an object' };
  if (value.format !== 1) return { ok: false, error: 'unknown catalog format' };
  if (!isDate(value.publishedAt)) return { ok: false, error: 'publishedAt is not a date' };
  if (!Array.isArray(value.models) || !Array.isArray(value.providers)) {
    return { ok: false, error: 'catalog needs models and providers arrays' };
  }
  const models = value.models.map(parseModel).filter((model): model is CanonicalModel => model !== null);
  const modelIds = new Set(models.map((model) => model.id));
  const dropped: CatalogDrop[] = [];
  const providers: CatalogProvider[] = [];
  for (const raw of value.providers) {
    const provider = parseProvider(raw, modelIds, dropped);
    if (!provider) continue;
    if (providers.some((kept) => kept.id === provider.id)) {
      dropped.push({ providerId: provider.id, reason: 'duplicate provider id; the first is kept' });
      continue;
    }
    providers.push(provider);
  }
  return { ok: true, catalog: { format: 1, publishedAt: value.publishedAt, models, providers }, dropped };
}

/** The provider's own model ids for its catalog offers, in catalog order. Empty for a provider the catalog doesn't list. */
export function providerModelIds(catalog: ConfidentialCatalog, providerId: string): string[] {
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  return Object.values(provider?.offers ?? {}).map((offer) => offer.providerModelId);
}
