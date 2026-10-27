const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count in binary units (1 KB = 1024 bytes), the way macOS reports memory: a 16 GiB
 * Mac reads "16 GB". One decimal below 10 ("1.5 GB", "2 GB"), whole numbers from 10 up.
 * Negative or non-finite input reads as 0 B.
 */
export function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1024) return `${Math.round(n)} B`;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${roundForDisplay(value)} ${BYTE_UNITS[unit]}`;
}

/**
 * A token count in thousands with the same rounding as formatBytes: "950", "6k", "6.4k",
 * "33k" for 32,768, "128k".
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return `${roundForDisplay(n / 1000)}k`;
}

/** One decimal below 10 with a trailing ".0" dropped; whole numbers from 10 up. */
function roundForDisplay(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const tenths = Math.round(value * 10) / 10;
  return tenths >= 10 ? '10' : String(tenths);
}
