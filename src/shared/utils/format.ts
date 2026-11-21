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
 * A token count in K or M with the same rounding as formatBytes: "950", "6K", "6.4K", "33K" for
 * 32,768, "128K", "1.5M". The unit is chosen after rounding, so 999,950 reads "1M", not "1000K".
 */
export function formatTokenCount(n: number): string {
  const whole = Math.round(n);
  if (whole < 1000) return String(whole);
  const thousands = roundForDisplay(n / 1000);
  if (Number(thousands) < 1000) return `${thousands}K`;
  return `${roundForDisplay(n / 1_000_000)}M`;
}

/** "Maya", "Maya and Sam", "Maya, Sam and Priya" (no comma before the last); "" for none. */
export function joinNames(names: readonly string[], conjunction = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

/**
 * A path with a macOS or Linux home folder (`/Users/<name>`, `/home/<name>`) shortened to `~`:
 * "/Users/maya/code" reads "~/code". Other paths come back unchanged.
 */
export function abbreviateHome(path: string): string {
  const match = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  return match ? `~${match[1] ?? ''}` : path;
}

/** One decimal below 10 with a trailing ".0" dropped; whole numbers from 10 up. */
function roundForDisplay(value: number): string {
  if (value >= 10) return String(Math.round(value));
  const tenths = Math.round(value * 10) / 10;
  return tenths >= 10 ? '10' : String(tenths);
}
