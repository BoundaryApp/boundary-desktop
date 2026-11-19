/**
 * The size rule for a direct message's text (ADR 0054 §4), shared by main and the composer so
 * both count the same way.
 */

/** A DM's longest text in bytes, counted as it is escaped inside the signal's JSON. */
export const MAX_DIRECT_TEXT_BYTES = 3 * 1024;

const encoder = new TextEncoder();

/**
 * The UTF-8 bytes `text` takes inside a signal's JSON, without the quotes around it. A newline,
 * tab, quote or backslash takes 2 bytes, another control character or a lone surrogate 6.
 */
export function directTextBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).length - 2;
}
