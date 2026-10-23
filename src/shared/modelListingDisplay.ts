import type {
  ListedModel,
  ListedModelAaBenchmarks,
  ListedModelPricing,
} from './types/onboarding';

const TOKENS_PER_MILLION = 1_000_000;

function parsePerTokenPrice(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

/** Numeric prompt price (USD per token) for sorting; undefined when missing/invalid. */
export function getModelPromptPricePerToken(
  model: Pick<ListedModel, 'pricing'>
): number | undefined {
  return parsePerTokenPrice(model.pricing?.promptPerToken);
}

/** Format a USD-per-token price as a compact $/M string (e.g. `$0.75`, `$3`). */
export function formatUsdPerMillionTokens(perToken: string): string | undefined {
  const parsed = parsePerTokenPrice(perToken);
  if (parsed === undefined) return undefined;
  const perMillion = parsed * TOKENS_PER_MILLION;
  if (perMillion === 0) return '$0';
  const formatted = perMillion
    .toFixed(6)
    .replace(/\.?0+$/, '');
  return `$${formatted}`;
}

/**
 * Format prompt/completion prices for display.
 * Both sides at 0 → `Free`. Missing sides are omitted.
 */
export function formatModelPricing(pricing: ListedModelPricing | undefined): string | undefined {
  if (!pricing) return undefined;

  const prompt = parsePerTokenPrice(pricing.promptPerToken);
  const completion = parsePerTokenPrice(pricing.completionPerToken);
  if (prompt === undefined && completion === undefined) return undefined;

  if (prompt === 0 && completion === 0) {
    return 'Free';
  }

  const promptLabel =
    pricing.promptPerToken !== undefined && prompt !== undefined
      ? formatUsdPerMillionTokens(pricing.promptPerToken)
      : undefined;
  const completionLabel =
    pricing.completionPerToken !== undefined && completion !== undefined
      ? formatUsdPerMillionTokens(pricing.completionPerToken)
      : undefined;

  if (promptLabel && completionLabel) return `${promptLabel} / ${completionLabel}`;
  return promptLabel ?? completionLabel;
}

/** Compact context window label (e.g. `128K`, `1M`). */
export function formatContextLength(contextLength: number | undefined): string | undefined {
  if (contextLength === undefined || !Number.isFinite(contextLength) || contextLength <= 0) {
    return undefined;
  }

  if (contextLength >= 1_000_000) {
    const millions = contextLength / 1_000_000;
    const rounded = Math.round(millions * 10) / 10;
    const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${label}M`;
  }

  if (contextLength >= 1_000) {
    const thousands = contextLength / 1_000;
    const rounded = Math.round(thousands);
    return `${rounded}K`;
  }

  return String(Math.round(contextLength));
}

/**
 * Format Artificial Analysis Intelligence / Coding indexes.
 * e.g. `Int 71 · Code 66`. Missing sides are omitted.
 */
export function formatAaBenchmarks(aa: ListedModelAaBenchmarks | undefined): string | undefined {
  if (!aa) return undefined;

  const parts: string[] = [];
  if (typeof aa.intelligence === 'number' && Number.isFinite(aa.intelligence)) {
    parts.push(`Int ${Math.round(aa.intelligence)}`);
  }
  if (typeof aa.coding === 'number' && Number.isFinite(aa.coding)) {
    parts.push(`Code ${Math.round(aa.coding)}`);
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Secondary row meta for the model picker, e.g. `$0.75 / $3.75 · 1M ctx`. */
export function formatListedModelMeta(model: Pick<ListedModel, 'pricing' | 'contextLength'>): string | undefined {
  const parts: string[] = [];
  const pricing = formatModelPricing(model.pricing);
  if (pricing) parts.push(pricing);

  const context = formatContextLength(model.contextLength);
  if (context) parts.push(`${context} ctx`);

  return parts.length > 0 ? parts.join(' · ') : undefined;
}
