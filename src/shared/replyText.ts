/**
 * How assistant replies are set in the transcript. Settings › Reply text edits it; the
 * renderer turns it into the prose tokens in tokens.css.
 */
export type ReplyTextFace = 'serif' | 'sans';

export interface ReplyTextPreference {
  face: ReplyTextFace;
  /** Font size in px. */
  size: number;
  /** Unitless line height. */
  lineHeight: number;
  /** Space after a paragraph, list or block, in em. */
  paragraphGap: number;
  /** Space above and below each list item, in em. */
  listGap: number;
  /** Font weight. Only IBM Plex Sans is variable; the serif ships at 400 and 600. */
  weight: number;
}

export const DEFAULT_REPLY_TEXT: ReplyTextPreference = {
  face: 'serif',
  size: 15.5,
  lineHeight: 1.7,
  paragraphGap: 1.1,
  listGap: 0.5,
  weight: 400,
};

type NumericKey = Exclude<keyof ReplyTextPreference, 'face'>;

/** Slider bounds and steps. Stored values are clamped to these and snapped to the step. */
export const REPLY_TEXT_RANGES: Record<NumericKey, { min: number; max: number; step: number }> = {
  size: { min: 14, max: 18, step: 0.5 },
  lineHeight: { min: 1.4, max: 1.9, step: 0.02 },
  paragraphGap: { min: 0.5, max: 1.5, step: 0.05 },
  listGap: { min: 0, max: 0.8, step: 0.05 },
  weight: { min: 400, max: 480, step: 10 },
};

/** localStorage key the renderer reads synchronously for first paint. */
export const REPLY_TEXT_STORAGE_KEY = 'boundary.replyText';

function snap(key: NumericKey, value: unknown): number {
  const { min, max, step } = REPLY_TEXT_RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REPLY_TEXT[key];
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = min + Math.round((clamped - min) / step) * step;
  // Round off float noise from the step arithmetic (1.4 + 15 * 0.02 = 1.7000000000000002).
  return Math.round(snapped * 1000) / 1000;
}

/** Any stored value, made valid: unknown fields drop, missing or bad ones take the default. */
export function normalizeReplyText(value: unknown): ReplyTextPreference {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    face: input.face === 'sans' || input.face === 'serif' ? input.face : DEFAULT_REPLY_TEXT.face,
    size: snap('size', input.size),
    lineHeight: snap('lineHeight', input.lineHeight),
    paragraphGap: snap('paragraphGap', input.paragraphGap),
    listGap: snap('listGap', input.listGap),
    weight: snap('weight', input.weight),
  };
}

export function isDefaultReplyText(preference: ReplyTextPreference): boolean {
  return (Object.keys(DEFAULT_REPLY_TEXT) as Array<keyof ReplyTextPreference>).every(
    (key) => preference[key] === DEFAULT_REPLY_TEXT[key]
  );
}

/** One-line summary for the Settings row, e.g. "Serif · 15.5px · line height 1.7". */
export function describeReplyText(preference: ReplyTextPreference): string {
  const face = preference.face === 'sans' ? 'Sans' : 'Serif';
  return `${face} · ${preference.size}px · line height ${preference.lineHeight}`;
}
