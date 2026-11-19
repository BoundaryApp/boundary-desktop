/**
 * How a turn's text arrived: chunk sizes and the gaps between them, for tuning the chat
 * screen's reveal pacing. Lengths and timings only; the text itself is never kept.
 */

/** A gap this long or longer is a visible stall rather than ordinary jitter. */
export const STALL_GAP_MS = 250;

export interface StreamCadenceSummary {
  chunks: number;
  chars: number;
  /** First chunk to last chunk. */
  spanMs: number;
  /** Characters per second over the span; null with fewer than two chunks. */
  charsPerSec: number | null;
  chunkCharsP50: number;
  chunkCharsMax: number;
  gapMsP50: number | null;
  gapMsP90: number | null;
  gapMsMax: number | null;
  /** Gaps of at least {@link STALL_GAP_MS}. */
  stalls: number;
}

export interface StreamCadence {
  /** Record one chunk's length at time `at` (epoch ms). */
  add(length: number, at: number): void;
  /** Null when no chunk arrived. */
  summary(): StreamCadenceSummary | null;
}

/** Nearest-rank percentile of an already sorted list. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function createStreamCadence(): StreamCadence {
  const sizes: number[] = [];
  const gaps: number[] = [];
  let first: number | null = null;
  let last: number | null = null;
  let chars = 0;
  return {
    add(length, at) {
      if (length <= 0) return;
      if (last != null) gaps.push(Math.max(0, at - last));
      if (first == null) first = at;
      last = at;
      sizes.push(length);
      chars += length;
    },
    summary() {
      if (sizes.length === 0 || first == null || last == null) return null;
      const sortedSizes = [...sizes].sort((a, b) => a - b);
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const spanMs = last - first;
      const hasGaps = sortedGaps.length > 0;
      return {
        chunks: sizes.length,
        chars,
        spanMs,
        charsPerSec: hasGaps && spanMs > 0 ? Math.round((chars / spanMs) * 10000) / 10 : null,
        chunkCharsP50: percentile(sortedSizes, 50),
        chunkCharsMax: sortedSizes[sortedSizes.length - 1],
        gapMsP50: hasGaps ? percentile(sortedGaps, 50) : null,
        gapMsP90: hasGaps ? percentile(sortedGaps, 90) : null,
        gapMsMax: hasGaps ? sortedGaps[sortedGaps.length - 1] : null,
        stalls: gaps.filter((gap) => gap >= STALL_GAP_MS).length,
      };
    },
  };
}
