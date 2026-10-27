interface HasUpdatedAt {
  updatedAt?: string | null;
}

function updatedMs(row: HasUpdatedAt): number {
  const ms = Date.parse(row.updatedAt ?? '');
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * Comparator for `sort`: latest `updatedAt` first. Rows with a missing or unparsable date go
 * last and compare equal to each other, so a stable sort keeps their input order.
 */
export function newestFirst(a: HasUpdatedAt, b: HasUpdatedAt): number {
  const ta = updatedMs(a);
  const tb = updatedMs(b);
  if (ta === tb) return 0;
  return tb > ta ? 1 : -1;
}
