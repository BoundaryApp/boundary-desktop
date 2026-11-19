/**
 * Paces how a streamed reply appears: text that arrives in bursts is revealed at a steady
 * rate a little behind the stream, whole words at a time.
 *
 * The reveal rate is proportional to the backlog (received but not shown), so a steady
 * stream settles with about {@link CUSHION_MS} of text in hand. That cushion covers the
 * gaps and bursts of a slow or bursty model, and through a longer stall the reveal slows
 * down rather than stopping dead. Once the stream ends, what is left shows within
 * {@link END_DRAIN_MS}.
 */

/** Before the first reveal: wait for a whole word, or this long, whichever comes first. */
export const FIRST_HOLD_MS = 250;
/** How much text, in time at the current rate, the reveal keeps in hand. */
export const CUSHION_MS = 600;
/** Slowest reveal, so the tail of a stalled stream doesn't crawl. */
export const MIN_CHARS_PER_SEC = 30;
/** After the stream ends, the rest shows within this long. */
export const END_DRAIN_MS = 300;

/** The end of the last whole word within `text[0, limit)`: just after whitespace. */
export function lastWordBoundary(text: string, limit: number): number {
  for (let i = Math.min(limit, text.length); i > 0; i -= 1) {
    if (/\s/.test(text[i - 1])) return i;
  }
  return 0;
}

/** The end of the first whole word: the whitespace after the first non-space; 0 if none yet. */
export function firstWordEnd(text: string): number {
  const start = text.search(/\S/);
  if (start < 0) return 0;
  const gap = text.slice(start).search(/\s/);
  return gap < 0 ? 0 : start + gap + 1;
}

export interface StreamPacerFrame {
  /** How many characters of the received text to show. */
  shown: number;
  /** False once the stream has ended and everything is shown. */
  pacing: boolean;
}

export class StreamPacer {
  private target = '';
  private done = false;
  /** Reveal position in characters; fractional between frames. */
  private position = 0;
  private shown = 0;
  private firstAt: number | null = null;
  private lastTick: number | null = null;
  /** Rate for the end drain, fixed when the stream ends. */
  private drainRate: number | null = null;

  /** The text received so far, and whether the stream has ended. */
  update(text: string, done: boolean, now: number): void {
    // Text that doesn't extend what is shown (an edit, a reload) restarts the reveal
    // from the part still shared.
    if (!text.startsWith(this.target.slice(0, this.shown))) {
      let common = 0;
      while (common < this.shown && text[common] === this.target[common]) common += 1;
      this.shown = common;
      this.position = common;
    }
    this.target = text;
    if (text.length > 0 && this.firstAt == null) this.firstAt = now;
    if (done && !this.done) {
      this.done = true;
      const backlog = text.length - this.position;
      this.drainRate = Math.max(MIN_CHARS_PER_SEC, (backlog * 1000) / END_DRAIN_MS);
    }
  }

  /** Advance to `now` and say how much to show. */
  tick(now: number): StreamPacerFrame {
    const elapsed = this.lastTick == null ? 0 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const length = this.target.length;

    if (this.firstAt != null) {
      if (this.shown === 0 && !this.done) {
        // The first reveal: one whole word, or after the hold whatever has come.
        const word = firstWordEnd(this.target);
        if (word > 0) this.position = Math.max(this.position, word);
        else if (now - this.firstAt >= FIRST_HOLD_MS) this.position = length;
      } else {
        const backlog = length - this.position;
        const rate =
          this.drainRate ?? Math.max(MIN_CHARS_PER_SEC, (backlog * 1000) / CUSHION_MS);
        this.position = Math.min(length, this.position + (rate * elapsed) / 1000);
      }
    }

    const reach = Math.floor(this.position);
    // Mid-stream, stop after a whole word; a first word still unfinished after the hold
    // shows as it is.
    const boundary = this.done ? reach : lastWordBoundary(this.target, reach);
    const next = boundary === 0 ? reach : boundary;
    this.shown = Math.min(length, Math.max(this.shown, next));
    return { shown: this.shown, pacing: !this.done || this.shown < length };
  }
}
