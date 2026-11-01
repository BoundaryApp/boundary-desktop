import type { CircleDayUsage, CircleLimit, CircleLimits, CircleUsageCount } from './types/circles';

/** Usage counts stay on the provider's and the member's own devices (ADR 0034 §5). */

const NO_LIMIT: CircleLimit = {};
const NOTHING_USED: CircleUsageCount = { requests: 0, tokens: 0 };

/** The calendar day on this device, which is when daily limits start over. */
export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** What one person has used today; yesterday's counts read as nothing. */
export function usedToday(usage: CircleDayUsage | undefined, identity: string, today: string): CircleUsageCount {
  return usage?.day === today ? (usage.counts[identity] ?? NOTHING_USED) : NOTHING_USED;
}

/** Add to one person's day, starting a new day's counts when the day has changed. */
export function addUsage(
  usage: CircleDayUsage | undefined,
  identity: string,
  today: string,
  added: Partial<CircleUsageCount>
): CircleDayUsage {
  const used = usedToday(usage, identity, today);
  return {
    day: today,
    counts: {
      ...(usage?.day === today ? usage.counts : {}),
      [identity]: {
        requests: Math.max(0, used.requests + (added.requests ?? 0)),
        tokens: Math.max(0, used.tokens + (added.tokens ?? 0)),
      },
    },
  };
}

/** A member's own limit replaces the one for everyone; an empty one means no limit. */
export function limitFor(limits: CircleLimits | null | undefined, identity: string): CircleLimit {
  return limits?.members[identity] ?? limits?.everyone ?? NO_LIMIT;
}
