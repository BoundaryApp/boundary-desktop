import { describe, expect, it } from 'vitest';
import { formatTokenCount, horizonLabel, horizonPlacement } from '../dmHorizon';

const rows = [10, 11, 12, 13].map((rowId) => ({ metadata: { custom: { rowId } } }));
const cut = (over: Partial<{ budget: number | null; tokens: number | null; firstRowId: number | null; summarised: boolean }>) => ({
  budget: 8000,
  tokens: 6000,
  firstRowId: 12,
  summarised: false,
  ...over,
});

describe('horizonPlacement (chat types Phase 7b)', () => {
  it('sits on the first included row', () => {
    expect(horizonPlacement(cut({}), rows)?.index).toBe(2);
  });

  it('draws nothing without a budget, a row id, or that row loaded', () => {
    expect(horizonPlacement(null, rows)).toBeNull();
    expect(horizonPlacement(cut({ budget: null }), rows)).toBeNull();
    expect(horizonPlacement(cut({ firstRowId: null }), rows)).toBeNull();
    expect(horizonPlacement(cut({ firstRowId: 99 }), rows)).toBeNull();
  });

  it('draws nothing when the whole thread fits, unless it is summarised', () => {
    expect(horizonPlacement(cut({ firstRowId: 10 }), rows)).toBeNull();
    expect(horizonPlacement(cut({ firstRowId: 10, summarised: true }), rows)?.index).toBe(0);
  });

  it('skips live messages that have no row id yet', () => {
    const live = [{ metadata: { custom: {} } }, ...rows];
    expect(horizonPlacement(cut({ firstRowId: 10 }), live)).toBeNull();
    expect(horizonPlacement(cut({ firstRowId: 11 }), live)?.index).toBe(2);
  });
});

describe('horizonLabel', () => {
  it('says what the next reply sees and how much of the budget', () => {
    expect(horizonLabel('Ana', { ...cut({}), budget: 8000 })).toBe(
      'Ana’s next reply sees from here down · about 6k of 8k tokens'
    );
  });

  it('says so when the earlier part is summarised', () => {
    expect(horizonLabel('Ana', { ...cut({ summarised: true, tokens: 7450 }), budget: 8000 })).toBe(
      'Earlier messages are summarised for Ana · about 7.5k of 8k tokens'
    );
  });

  it('leaves the count out when tokens are unknown', () => {
    expect(horizonLabel('Ana', { ...cut({ tokens: null }), budget: 8000 })).toBe(
      'Ana’s next reply sees from here down'
    );
  });
});

describe('formatTokenCount', () => {
  it('rounds to k', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(6000)).toBe('6k');
    expect(formatTokenCount(6420)).toBe('6.4k');
    expect(formatTokenCount(32_768)).toBe('33k');
  });
});
