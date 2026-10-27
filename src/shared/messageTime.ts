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

/** "22 Sep" in the user's locale, with the year when it is not this year. '' when `ms` is not a number. */
export function formatShortDate(ms: number, now = Date.now(), locale?: string): string {
  if (!Number.isFinite(ms)) return '';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A chat list row: the time for today and yesterday, "22 Sep" before that. '' when `ms` is not a number. */
export function formatRowTime(ms: number, now = Date.now(), locale?: string): string {
  if (!Number.isFinite(ms)) return '';
  const day = formatDayLabel(ms, now, locale);
  if (day === 'Today' || day === 'Yesterday') return formatMessageTime(ms, locale);
  return new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** "Today 2:14 PM", "Yesterday 2:14 PM", or the day label alone. '' when `ms` is not a number. */
export function formatDayAndTime(ms: number, now = Date.now(), locale?: string): string {
  if (!Number.isFinite(ms)) return '';
  const day = formatDayLabel(ms, now, locale);
  if (day === 'Today' || day === 'Yesterday') return `${day} ${formatMessageTime(ms, locale)}`;
  return day;
}

/** ISO 8601 string from anything `toUnixSeconds` accepts; undefined when unusable. */
export function toIsoTimestamp(value: unknown): string | undefined {
  const seconds = toUnixSeconds(value);
  return seconds == null ? undefined : new Date(seconds * 1000).toISOString();
}
