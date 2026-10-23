import type { HermesChatUsageSnapshot } from '../../../shared/types/hermesChat';

/** Format context gauge labels per ADR 0004 — never show 0% when max is unknown. */
export function formatContextGauge(usage?: HermesChatUsageSnapshot | null): {
  label: string;
  percentLabel: string | null;
  showBar: boolean;
  percent: number | null;
  empty: boolean;
} {
  if (!usage) {
    return {
      label: '— / —',
      percentLabel: null,
      showBar: false,
      percent: null,
      empty: true,
    };
  }

  const used = usage.contextUsed;
  const max = usage.contextMax;
  if (max == null || max <= 0) {
    return {
      label: 'context max unknown',
      percentLabel: null,
      showBar: false,
      percent: null,
      empty: false,
    };
  }

  const usedLabel =
    used != null ? formatTokenCount(used) : '—';
  const maxLabel = formatTokenCount(max);
  const prefix = usage.contextEstimated ? '~' : '';
  const percent =
    usage.contextPercent != null && Number.isFinite(usage.contextPercent)
      ? usage.contextPercent
      : used != null
        ? (used / max) * 100
        : null;

  return {
    label: `${prefix}${usedLabel} / ${maxLabel}`,
    percentLabel: percent != null ? `${Math.round(percent)}%` : null,
    showBar: percent != null,
    percent,
    empty: false,
  };
}

/**
 * Split the context bar into fixed overhead (system prompt, tools, rules, memory…) and
 * conversation. Category counts are local estimates, so only their ratio is used: the two
 * segments always sum to `percent`, the window occupancy the label reports.
 */
export function splitContextBar(
  percent: number | null,
  categories: ReadonlyArray<{ id: string; tokens: number }> | null | undefined
): { overhead: number; conversation: number } | null {
  if (percent == null || !categories?.length) return null;
  let conversation = 0;
  let total = 0;
  for (const c of categories) {
    const tokens = Number.isFinite(c.tokens) && c.tokens > 0 ? c.tokens : 0;
    total += tokens;
    if (c.id === 'conversation') conversation += tokens;
  }
  if (total <= 0) return null;
  const width = Math.max(0, Math.min(100, percent));
  const conversationWidth = (width * conversation) / total;
  return { overhead: width - conversationWidth, conversation: conversationWidth };
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    if (Number.isInteger(k)) return `${k}k`;
    return `${k.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

export function formatPhaseLine(opts: {
  phase: string;
  elapsedSec?: number;
  toolName?: string;
  toolTurn?: number;
  maxTurns?: number;
  visibleTokens?: number;
  avgTps?: number | null;
}): string {
  switch (opts.phase) {
    case 'preparing':
      return opts.elapsedSec != null && opts.elapsedSec > 0
        ? `Preparing · ${opts.elapsedSec}s`
        : 'Preparing…';
    case 'restarting':
      return opts.toolName
        ? `Restarting assistant to apply ${opts.toolName}…`
        : 'Restarting assistant…';
    case 'tool': {
      const name = opts.toolName ?? 'tool';
      if (opts.toolTurn != null && opts.maxTurns != null) {
        return `${name} · ${opts.toolTurn} / ${opts.maxTurns}`;
      }
      if (opts.toolTurn != null) {
        return `${name} · turn ${opts.toolTurn}`;
      }
      return name;
    }
    case 'generating': {
      const tok = opts.visibleTokens ?? 0;
      const tps = opts.avgTps;
      if (tps != null && tps > 0) {
        return `${tok} tok · ${tps.toFixed(0)}/s`;
      }
      return tok > 0 ? `${tok} tok` : 'Generating…';
    }
    case 'done':
      return 'Done';
    default:
      return '';
  }
}

export function displayHostPath(hostPath: string): string {
  // Renderer has no os.homedir reliably across platforms via Node; use a simple heuristic.
  const home =
    typeof window !== 'undefined'
      ? // Electron preload could expose home; fall back to common prefixes.
        (window as unknown as { __boundaryHome?: string }).__boundaryHome
      : undefined;
  if (home && (hostPath === home || hostPath.startsWith(`${home}/`))) {
    return hostPath === home ? '~' : `~${hostPath.slice(home.length)}`;
  }
  // macOS / Linux heuristic when home is unknown: replace /Users/<name>
  const m = hostPath.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) {
    return m[1] ? `~${m[1]}` : '~';
  }
  return hostPath;
}

export function projectGlyph(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : 'P';
}

const GLYPH_COLORS = ['#c4a574', '#6f8fa3', '#8b87f8', '#86c089', '#c4843a'];

export function projectGlyphColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash + id.charCodeAt(i) * (i + 1)) % GLYPH_COLORS.length;
  }
  return GLYPH_COLORS[hash] ?? GLYPH_COLORS[0];
}

/** Agent mini-glyph letter from display name. */
export function agentGlyph(displayName: string): string {
  const ch = displayName.trim().charAt(0);
  return ch ? ch.toUpperCase() : 'A';
}

const AGENT_GLYPH_COLORS = [
  '#3a3a44',
  '#8a7aa8',
  '#6f8fa3',
  '#6d9470',
  '#a17c45',
  '#b07a5a',
];

export function agentGlyphColor(slug: string): string {
  if (slug === 'assistant') return '#3a3a44';
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) {
    hash = (hash + slug.charCodeAt(i) * (i + 1)) % AGENT_GLYPH_COLORS.length;
  }
  const color = AGENT_GLYPH_COLORS[hash] ?? AGENT_GLYPH_COLORS[0];
  return color === '#3a3a44' ? AGENT_GLYPH_COLORS[1]! : color;
}

