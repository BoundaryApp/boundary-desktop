import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../../../shared/types/confidentialState';
import { SPEND_ENTRY_LIMIT, SPEND_WINDOW_MS, SpendLog, summarizeSpend } from '../spendLog';

const now = 1_800_000_000_000;

function makeStore(entries: unknown = []): { get: () => unknown; set: (_key: string, value: unknown) => void; stored: () => unknown } {
  let value = entries;
  return {
    get: () => value,
    set: (_key, next) => {
      value = next;
    },
    stored: () => value,
  };
}

function entry(overrides: Partial<SpendEntry> = {}): SpendEntry {
  return {
    at: now - 1000,
    providerId: 'near',
    modelId: 'qwen38-27b',
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 10,
    cost: 0.01,
    ...overrides,
  };
}

function logWith(initial: unknown): { log: SpendLog; store: ReturnType<typeof makeStore> } {
  const store = makeStore(initial);
  return { log: new SpendLog(store as never), store };
}

describe('SpendLog', () => {
  it('returns a recorded entry', () => {
    const { log } = logWith([]);
    log.record(entry(), now);
    expect(log.entries(now)).toEqual([entry()]);
  });

  it('keeps an entry at the window edge and drops one just past it', () => {
    const edge = entry({ at: now - SPEND_WINDOW_MS });
    const old = entry({ at: now - SPEND_WINDOW_MS - 1 });
    const { log, store } = logWith([old, edge]);
    expect(log.entries(now)).toEqual([edge]);
    log.record(entry(), now);
    expect(store.stored()).toEqual([edge, entry()]);
  });

  it('keeps at most the entry limit and drops the oldest', () => {
    const full = Array.from({ length: SPEND_ENTRY_LIMIT }, (_, i) => entry({ at: now - 100_000 + i }));
    const { log, store } = logWith(full);
    const added = entry({ at: now });
    log.record(added, now);
    const stored = store.stored() as SpendEntry[];
    expect(stored).toHaveLength(SPEND_ENTRY_LIMIT);
    expect(stored[0]).toEqual(full[1]);
    expect(stored[stored.length - 1]).toEqual(added);
  });

  it('drops malformed stored entries', () => {
    expect(logWith('x').log.entries(now)).toEqual([]);
    const valid = entry();
    const { log } = logWith([
      valid,
      {},
      { ...valid, providerId: 3 },
      { ...valid, inputTokens: -1 },
      { ...valid, inputTokens: 1.5 },
      { ...valid, cachedTokens: 0.5 },
      { ...valid, outputTokens: 2.5 },
      { ...valid, at: now + 60_001 },
    ]);
    expect(log.entries(now)).toEqual([valid]);
  });

  it('keeps a stored entry with null counts and a fractional cost', () => {
    const nulls = entry({ inputTokens: null, cachedTokens: null, outputTokens: null, cost: null });
    const fractional = entry({ cost: 0.000126 });
    expect(logWith([nulls, fractional]).log.entries(now)).toEqual([nulls, fractional]);
  });
});

describe('summarizeSpend', () => {
  const providers: Parameters<typeof summarizeSpend>[1] = [
    { id: 'near', name: 'NEAR AI', level: 'A', added: true, balance: 12.5 },
    { id: 'prem', name: 'Premium', level: 'B', added: true, balance: null },
    { id: 'chutes', name: 'Chutes', level: 'C', added: false, balance: 3 },
  ];

  it('sums per provider, counts turns without counts and sorts by cost', () => {
    const summary = summarizeSpend(
      [
        entry({ inputTokens: 100, outputTokens: 10, cost: 0.01 }),
        entry({ inputTokens: 200, outputTokens: 20, cost: 0.02 }),
        entry({ inputTokens: null, cachedTokens: null, outputTokens: null, cost: null }),
        entry({ providerId: 'prem', cost: 0.5 }),
      ],
      providers,
      now
    );
    expect(summary.since).toBe(now - SPEND_WINDOW_MS);
    expect(summary.totalTurns).toBe(4);
    expect(summary.totalCost).toBeCloseTo(0.53, 9);
    expect(summary.rows.map((row) => row.providerId)).toEqual(['prem', 'near']);
    const near = summary.rows[1];
    expect(near).toMatchObject({ turns: 3, turnsWithoutCounts: 1, inputTokens: 300, outputTokens: 30, balance: 12.5, removed: false });
    expect(near.cost).toBeCloseTo(0.03, 9);
  });

  it('gives an added provider without entries a row of zeros', () => {
    const summary = summarizeSpend([], providers, now);
    expect(summary.rows.map((row) => row.providerId)).toEqual(['near', 'prem']);
    expect(summary.rows[0]).toMatchObject({ turns: 0, turnsWithoutCounts: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
  });

  it('keeps a removed provider’s row while it has turns', () => {
    const summary = summarizeSpend([entry({ providerId: 'chutes', cost: 0.1 })], providers, now);
    const row = summary.rows.find((r) => r.providerId === 'chutes');
    expect(row).toMatchObject({ removed: true, balance: null, turns: 1 });
  });

  it('leaves out entries for a provider the catalog dropped', () => {
    const summary = summarizeSpend([entry({ providerId: 'gone' })], providers, now);
    expect(summary.rows.find((r) => r.providerId === 'gone')).toBeUndefined();
    expect(summary.totalTurns).toBe(0);
  });
});
