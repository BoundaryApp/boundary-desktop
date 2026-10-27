import { describe, expect, it } from 'vitest';
import { newestFirst } from '../sort';

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('newestFirst', () => {
  it('puts the latest updatedAt first', () => {
    const rows = [
      { id: 'old', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'new', updatedAt: '2026-03-01T00:00:00Z' },
      { id: 'mid', updatedAt: '2026-02-01T00:00:00Z' },
    ];
    expect(ids([...rows].sort(newestFirst))).toEqual(['new', 'mid', 'old']);
  });

  // Three copies subtracted Date.parse results directly, so these rows made the comparator NaN.
  it('sorts missing and unparsable dates last, in input order', () => {
    const rows = [
      { id: 'none' },
      { id: 'dated', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'bad', updatedAt: 'not a date' },
      { id: 'null', updatedAt: null },
      { id: 'later', updatedAt: '2026-05-01T00:00:00Z' },
    ];
    expect(ids([...rows].sort(newestFirst))).toEqual(['later', 'dated', 'none', 'bad', 'null']);
  });

  it('compares instants, not strings', () => {
    const rows = [
      { id: 'a', updatedAt: '2026-01-01T10:00:00+02:00' },
      { id: 'b', updatedAt: '2026-01-01T09:00:00Z' },
    ];
    expect(ids([...rows].sort(newestFirst))).toEqual(['b', 'a']);
  });
});
