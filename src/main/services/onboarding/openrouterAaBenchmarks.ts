import type { ListedModelAaBenchmarks } from '../../../shared/types/onboarding';

const AA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const BENCHMARKS_TIMEOUT_MS = 30_000;

/** Known OpenRouter routing variants that share weights with the canonical model. */
const OPENROUTER_VARIANT_SUFFIX = /:(?:free|nitro|extended|floor|exacto)$/i;

type AaBenchmarkItem = {
  source?: string;
  model_permaslug?: string;
  intelligence_index?: number | null;
  coding_index?: number | null;
};

type AaCacheEntry = {
  fetchedAt: number;
  byPermaslug: Map<string, ListedModelAaBenchmarks>;
};

const cacheByOrigin = new Map<string, AaCacheEntry>();

export function clearOpenRouterAaCache(): void {
  cacheByOrigin.clear();
}

export function isOpenRouterEndpoint(
  baseUrl: string,
  provider: string | undefined
): boolean {
  if (provider === 'openrouter') return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.includes('openrouter.ai');
  } catch {
    return false;
  }
}

function benchmarksUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/api/v1/benchmarks?source=artificial-analysis`;
  } catch {
    return undefined;
  }
}

function cacheKey(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

function parseFiniteScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

export function parseAaBenchmarksResponse(
  body: unknown
): Map<string, ListedModelAaBenchmarks> {
  const byPermaslug = new Map<string, ListedModelAaBenchmarks>();
  const record = body as { data?: AaBenchmarkItem[] };
  if (!Array.isArray(record?.data)) return byPermaslug;

  for (const item of record.data) {
    if (item?.source !== 'artificial-analysis') continue;
    const slug =
      typeof item.model_permaslug === 'string' ? item.model_permaslug.trim() : '';
    if (!slug) continue;

    const intelligence = parseFiniteScore(item.intelligence_index);
    const coding = parseFiniteScore(item.coding_index);
    if (intelligence === undefined && coding === undefined) continue;

    byPermaslug.set(slug, {
      ...(intelligence !== undefined ? { intelligence } : {}),
      ...(coding !== undefined ? { coding } : {}),
    });
  }

  return byPermaslug;
}

/**
 * Resolve AA scores for a model id.
 * Exact permaslug match first; then strip a known OpenRouter `:variant` suffix.
 * Does not fuzzy-match date-versioned ids.
 */
export function lookupAaBenchmarks(
  modelId: string,
  byPermaslug: Map<string, ListedModelAaBenchmarks>
): ListedModelAaBenchmarks | undefined {
  const exact = byPermaslug.get(modelId);
  if (exact) return exact;

  if (!OPENROUTER_VARIANT_SUFFIX.test(modelId)) return undefined;
  const canonical = modelId.replace(OPENROUTER_VARIANT_SUFFIX, '');
  if (!canonical || canonical === modelId) return undefined;
  return byPermaslug.get(canonical);
}

export async function fetchOpenRouterAaBenchmarks(input: {
  baseUrl: string;
  headers: Record<string, string>;
}): Promise<Map<string, ListedModelAaBenchmarks>> {
  const key = cacheKey(input.baseUrl);
  if (key) {
    const cached = cacheByOrigin.get(key);
    if (cached && Date.now() - cached.fetchedAt < AA_CACHE_TTL_MS) {
      return cached.byPermaslug;
    }
  }

  const url = benchmarksUrl(input.baseUrl);
  if (!url) return new Map();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: input.headers,
      signal: AbortSignal.timeout(BENCHMARKS_TIMEOUT_MS),
    });

    if (!res.ok) return new Map();

    const text = await res.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Map();
    }

    const byPermaslug = parseAaBenchmarksResponse(parsed);
    if (key) {
      cacheByOrigin.set(key, { fetchedAt: Date.now(), byPermaslug });
    }
    return byPermaslug;
  } catch {
    return new Map();
  }
}
