import { describe, expect, it } from 'vitest';
import { formatDayLabel, localDayKey } from '../../../../shared/messageTime';
import { dmDays, matchOffsets, stepMatch } from '../dmThreadIndex';

const at = (iso: string) => ({ metadata: { custom: { ts: Date.parse(iso) / 1000 } } });

describe('dmDays', () => {
  it('lists each local day once, oldest first, skipping untimed messages', () => {
    const now = Date.parse('2026-10-01T12:00:00');
    const days = dmDays(
      [
        at('2026-09-22T09:00:00'),
        at('2026-09-22T18:00:00'),
        {},
        at('2026-09-30T10:00:00'),
        at('2026-10-01T08:00:00'),
      ],
      now
    );
    expect(days.map((d) => d.label)).toEqual([
      formatDayLabel(Date.parse('2026-09-22T09:00:00'), now),
      'Yesterday',
      'Today',
    ]);
    expect(new Set(days.map((d) => d.key)).size).toBe(3);
  });

  it('builds an index for several hundred messages', () => {
    const start = Date.parse('2026-06-01T09:00:00');
    const messages = Array.from({ length: 600 }, (_, i) => ({
      metadata: { custom: { ts: (start + i * 6 * 3_600_000) / 1000 } },
    }));
    const expected = new Set(messages.map((m) => localDayKey(m.metadata.custom.ts * 1000)));
    expect(dmDays(messages).map((d) => d.key)).toEqual([...expected]);
  });
});

describe('matchOffsets', () => {
  it('finds every match ignoring case, without overlaps', () => {
    expect(matchOffsets('Pricing, pricing, PRICING', 'pricing')).toEqual([
      [0, 7],
      [9, 16],
      [18, 25],
    ]);
    expect(matchOffsets('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('finds nothing for a blank query', () => {
    expect(matchOffsets('anything', '  ')).toEqual([]);
  });
});

describe('stepMatch', () => {
  it('wraps both ways and starts from the right end', () => {
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
