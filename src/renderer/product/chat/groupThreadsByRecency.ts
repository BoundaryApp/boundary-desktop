import type { HermesChatThreadSummary } from '../../../shared/types/hermesChat';

export type RecencyBucketId =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'older';

export interface RecencyBucket {
  id: RecencyBucketId;
  label: string;
}

export interface RecencyThreadGroup {
  id: RecencyBucketId;
  label: string;
  threads: HermesChatThreadSummary[];
}

const BUCKETS: readonly RecencyBucket[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'thisWeek', label: 'This week' },
  { id: 'lastWeek', label: 'Last week' },
  { id: 'older', label: 'Older' },
] as const;

/**
 * Local calendar boundaries matching Hermes WebUI
 * (`_sessionCalendarBoundaries` in sessions.js).
 * Week starts Monday.
 */
export function sessionCalendarBoundaries(nowMs: number): {
  startOfToday: number;
  startOfYesterday: number;
  startOfWeek: number;
  startOfLastWeek: number;
} {
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1
  );
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  const startOfLastWeek = new Date(startOfWeek);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
  return {
    startOfToday: startOfToday.getTime(),
    startOfYesterday: startOfYesterday.getTime(),
    startOfWeek: startOfWeek.getTime(),
    startOfLastWeek: startOfLastWeek.getTime(),
  };
}

/**
 * Bucket label for a timestamp, matching Hermes WebUI
 * (`_sessionTimeBucketLabel`). Missing timestamps → Older.
 */
export function sessionTimeBucketId(
  timestampMs: number | null | undefined,
  nowMs: number
): RecencyBucketId {
  if (timestampMs == null || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return 'older';
  }
  const { startOfToday, startOfYesterday, startOfWeek, startOfLastWeek } =
    sessionCalendarBoundaries(nowMs);
  if (timestampMs >= startOfToday) return 'today';
  if (timestampMs >= startOfYesterday) return 'yesterday';
  if (timestampMs >= startOfWeek) return 'thisWeek';
  if (timestampMs >= startOfLastWeek) return 'lastWeek';
  return 'older';
}

function parseUpdatedAtMs(updatedAt: string | undefined): number | null {
  if (!updatedAt) return null;
  const ms = Date.parse(updatedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Group threads into Hermes-style recency buckets.
 * Empty buckets are omitted. Within each bucket, input order is preserved
 * (callers should already sort by updatedAt descending).
 */
export function groupThreadsByRecency(
  threads: readonly HermesChatThreadSummary[],
  nowMs: number = Date.now()
): RecencyThreadGroup[] {
  const buckets = new Map<RecencyBucketId, HermesChatThreadSummary[]>();
  for (const bucket of BUCKETS) {
    buckets.set(bucket.id, []);
  }

  for (const thread of threads) {
    const id = sessionTimeBucketId(parseUpdatedAtMs(thread.updatedAt), nowMs);
    buckets.get(id)!.push(thread);
  }

  return BUCKETS.filter((bucket) => (buckets.get(bucket.id)?.length ?? 0) > 0).map(
    (bucket) => ({
      id: bucket.id,
      label: bucket.label,
      threads: buckets.get(bucket.id)!,
    })
  );
}
