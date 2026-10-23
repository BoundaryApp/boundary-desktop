/**
 * Message timestamps: coercion from gateway / WebUI rows and display strings
 * for the transcript hover row and day dividers.
 */

/** Unix seconds from a number (seconds or ms) or a date string; null when unusable. */
export function toUnixSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value / 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return toUnixSeconds(asNum);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed / 1000;
  }
  return null;
}

/** "2:14 PM" in the user's locale. */
export function formatMessageTime(ms: number, locale?: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** "Tuesday, 29 September 2026 at 2:14:08 PM" — the hover tooltip. */
export function formatMessageTimeFull(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Local calendar day key, so two times can be compared for a day divider. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday", "Monday 28 September", or with the year when it is not this year. */
export function formatDayLabel(ms: number, now = Date.now(), locale?: string): string {
  const key = localDayKey(ms);
  if (key === localDayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDayKey(yesterday.getTime())) return 'Yesterday';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
