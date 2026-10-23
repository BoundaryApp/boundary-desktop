import { describe, expect, it } from 'vitest';
import type { HermesChatThreadSummary } from '../../../../shared/types/hermesChat';
import {
  groupThreadsByRecency,
  sessionCalendarBoundaries,
  sessionTimeBucketId,
} from '../groupThreadsByRecency';

/** Local Wednesday noon — mirrors Hermes WebUI’s 2026-04-15 fixture day. */
function localMs(
  year: number,
  monthIndex: number,
  day: number,
  hour = 12,
  minute = 0
): number {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
}

const NOW = localMs(2026, 3, 15, 14, 0);

function thread(
  id: string,
  updatedAtMs?: number
): HermesChatThreadSummary {
  return {
    id,
    title: id,
    updatedAt:
      updatedAtMs == null ? undefined : new Date(updatedAtMs).toISOString(),
  };
}

describe('sessionCalendarBoundaries', () => {
  it('uses Monday as the start of the week', () => {
    // Wed 2026-04-15 → Monday 2026-04-13 local
    const b = sessionCalendarBoundaries(NOW);
    expect(b.startOfToday).toBe(localMs(2026, 3, 15, 0, 0));
    expect(b.startOfYesterday).toBe(localMs(2026, 3, 14, 0, 0));
    expect(b.startOfWeek).toBe(localMs(2026, 3, 13, 0, 0));
    expect(b.startOfLastWeek).toBe(localMs(2026, 3, 6, 0, 0));
  });
});

describe('sessionTimeBucketId', () => {
  it('buckets today / yesterday / this week / last week / older', () => {
    expect(sessionTimeBucketId(localMs(2026, 3, 15, 12, 0), NOW)).toBe('today');
    expect(sessionTimeBucketId(localMs(2026, 3, 14, 23, 30), NOW)).toBe(
      'yesterday'
    );
    // Monday late same week
    expect(sessionTimeBucketId(localMs(2026, 3, 13, 23, 0), NOW)).toBe(
      'thisWeek'
    );
    // Previous week (Mon–Sun before current Monday)
    expect(sessionTimeBucketId(localMs(2026, 3, 8, 12, 0), NOW)).toBe(
      'lastWeek'
    );
    expect(sessionTimeBucketId(localMs(2026, 2, 5, 12, 0), NOW)).toBe('older');
  });

  it('treats missing timestamps as older', () => {
    expect(sessionTimeBucketId(null, NOW)).toBe('older');
    expect(sessionTimeBucketId(undefined, NOW)).toBe('older');
    expect(sessionTimeBucketId(0, NOW)).toBe('older');
  });
});

describe('groupThreadsByRecency', () => {
  it('returns only non-empty buckets in order', () => {
    const groups = groupThreadsByRecency(
      [
        thread('t-today', localMs(2026, 3, 15, 12, 0)),
        thread('t-yesterday', localMs(2026, 3, 14, 10, 0)),
        thread('t-last', localMs(2026, 3, 8, 10, 0)),
        thread('t-older', localMs(2026, 2, 1, 10, 0)),
        thread('t-missing'),
      ],
      NOW
    );

    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Last week',
      'Older',
    ]);
    expect(groups.find((g) => g.id === 'thisWeek')).toBeUndefined();
    expect(groups.find((g) => g.id === 'today')?.threads.map((t) => t.id)).toEqual([
      't-today',
    ]);
    expect(groups.find((g) => g.id === 'older')?.threads.map((t) => t.id)).toEqual([
      't-older',
      't-missing',
    ]);
  });

  it('preserves input order within a bucket', () => {
    const groups = groupThreadsByRecency(
      [
        thread('a', localMs(2026, 3, 15, 13, 0)),
        thread('b', localMs(2026, 3, 15, 11, 0)),
      ],
      NOW
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].threads.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list when there are no threads', () => {
    expect(groupThreadsByRecency([], NOW)).toEqual([]);
  });
});
