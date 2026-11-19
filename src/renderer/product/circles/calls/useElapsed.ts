import { useEffect, useState } from 'react';

/** `m:ss` for a duration in milliseconds. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The time since `since` as `m:ss`, redrawn once a second; null before the call connects. */
export function useElapsed(since: number | null): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => tick((count) => count + 1), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : formatDuration(Date.now() - since);
}
