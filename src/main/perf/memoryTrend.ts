/**
 * Lag probe: does memory keep climbing the longer the app runs? Each series (main heap,
 * each Electron process's memory, the page's JS heap and element count) gets one sample a
 * minute. After a warm-up, a series counts as growing when it has risen past both an
 * absolute and a relative threshold over its baseline, along a steady line rather than
 * a single spike (fit of a straight line through the samples).
 */

export interface SeriesRule {
  /** Growth below this (in the series' unit) never counts. */
  minGrowth: number;
  /** Nor growth below this fraction of the baseline. */
  minRatio: number;
}

export interface SeriesTrend {
  series: string;
  unit: string;
  baseline: number;
  now: number;
  growth: number;
  /** Per minute, from a straight-line fit through the samples since the warm-up. */
  slopePerMin: number;
  /** How well that line fits (0–1): near 1 is a steady climb, low is noise. */
  r2: number;
  samples: number;
  growing: boolean;
}

/** Samples skipped at the start: startup allocation is not a leak. */
const WARMUP_SAMPLES = 2;
/** Fewer samples than this after the warm-up are too few to call a trend. */
const MIN_TREND_SAMPLES = 4;
const MIN_FIT = 0.6;
const MAX_SAMPLES = 240;

export class MemoryTrend {
  private readonly samples = new Map<string, { at: number; value: number }[]>();
  private readonly units = new Map<string, string>();
  /** Growth last reported per series, so each series warns again only when it doubles. */
  private readonly reported = new Map<string, number>();

  constructor(private readonly rules: (series: string) => SeriesRule) {}

  add(series: string, value: number, unit: string, at = Date.now()): void {
    if (!Number.isFinite(value)) return;
    const list = this.samples.get(series) ?? [];
    list.push({ at, value });
    if (list.length > MAX_SAMPLES) list.splice(WARMUP_SAMPLES, 1);
    this.samples.set(series, list);
    this.units.set(series, unit);
  }

  /** Forget a series whose process has gone (a renderer reload starts a new pid). */
  drop(series: string): void {
    this.samples.delete(series);
    this.reported.delete(series);
  }

  seriesNames(): string[] {
    return [...this.samples.keys()];
  }

  trends(): SeriesTrend[] {
    const out: SeriesTrend[] = [];
    for (const [series, all] of this.samples) {
      const list = all.slice(WARMUP_SAMPLES);
      if (list.length < 2) continue;
      const baseline = list[0].value;
      const now = list[list.length - 1].value;
      const growth = now - baseline;
      const { slope, r2 } = fitLine(list.map((s) => [(s.at - list[0].at) / 60_000, s.value]));
      const rule = this.rules(series);
      const growing =
        list.length >= MIN_TREND_SAMPLES &&
        growth >= rule.minGrowth &&
        growth >= Math.abs(baseline) * rule.minRatio &&
        slope > 0 &&
        r2 >= MIN_FIT;
      out.push({
        series,
        unit: this.units.get(series) ?? '',
        baseline: round(baseline),
        now: round(now),
        growth: round(growth),
        slopePerMin: round(slope),
        r2: Math.round(r2 * 100) / 100,
        samples: list.length,
        growing,
      });
    }
    return out;
  }

  /** Series newly growing, or whose growth has doubled since they were last reported. */
  newFindings(): SeriesTrend[] {
    const found: SeriesTrend[] = [];
    for (const trend of this.trends()) {
      if (!trend.growing) continue;
      const last = this.reported.get(trend.series);
      if (last != null && trend.growth < last * 2) continue;
      this.reported.set(trend.series, trend.growth);
      found.push(trend);
    }
    return found;
  }
}

/** Least-squares line through (x, y) points: its slope and R². */
export function fitLine(points: [number, number][]): { slope: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  for (const [x, y] of points) {
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
