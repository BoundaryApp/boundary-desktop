import { formatDayLabel, localDayKey } from '../../../shared/messageTime';
import { messageTimeMs } from './messageMeta';

type TimedMessage = Parameters<typeof messageTimeMs>[0];

export interface DmDay {
  /** `localDayKey`, also on the day divider as `data-day`. */
  key: string;
  label: string;
  ms: number;
}

/** Each local day that has a message, oldest first: the Jump to date list (Phase 7a). */
export function dmDays(messages: readonly TimedMessage[], now = Date.now()): DmDay[] {
  const days: DmDay[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const ms = messageTimeMs(message);
    if (ms == null) continue;
    const key = localDayKey(ms);
    if (seen.has(key)) continue;
    seen.add(key);
    days.push({ key, label: formatDayLabel(ms, now), ms });
  }
  return days;
}

/** "Sep 22", with the year when it isn't this one. */
export function shortDate(ms: number, now = Date.now()): string {
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Where `query` occurs in `text`, ignoring case, as [start, end) offsets. Non-overlapping. */
export function matchOffsets(text: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hay = text.toLocaleLowerCase();
  const out: Array<[number, number]> = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    out.push([at, at + needle.length]);
  }
  return out;
}

/** The step after `current` of `count` matches, wrapping both ways; -1 when there are none. */
export function stepMatch(current: number, count: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}
