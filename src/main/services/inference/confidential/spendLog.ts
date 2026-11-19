import Store from 'electron-store';
import type {
  ConfidentialSpend,
  ConfidentialSpendRow,
  SpendEntry,
} from '../../../../shared/types/confidentialState';
import type { TrustLevel } from '../../../../shared/types/confidential';
import type { StoreLike } from './confidentialStore';

/**
 * A metadata-only log of the turns confidential pools answered (ADR 0047 phase 5): when, which
 * provider and model, token counts and estimated cost. Nothing about the chat itself.
 */

export const SPEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SPEND_ENTRY_LIMIT = 20_000;
/** An entry stamped further ahead than this is treated as corrupt. */
const CLOCK_SLACK_MS = 60_000;

function nonNegativeOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function tokenCountOrNull(value: unknown): boolean {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function isEntry(value: unknown, now: number): value is SpendEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    e.at <= now + CLOCK_SLACK_MS &&
    typeof e.providerId === 'string' &&
    typeof e.modelId === 'string' &&
    tokenCountOrNull(e.inputTokens) &&
    tokenCountOrNull(e.cachedTokens) &&
    tokenCountOrNull(e.outputTokens) &&
    nonNegativeOrNull(e.cost)
  );
}

export class SpendLog {
  private readonly store: StoreLike<{ entries: SpendEntry[] }>;

  constructor(store?: StoreLike<{ entries: SpendEntry[] }>) {
    this.store =
      store ?? new Store<{ entries: SpendEntry[] }>({ name: 'confidential-spend', defaults: { entries: [] } });
  }

  /** Valid entries inside the 30-day window, oldest first. */
  entries(now: number): SpendEntry[] {
    const stored: unknown = this.store.get('entries');
    if (!Array.isArray(stored)) return [];
    const since = now - SPEND_WINDOW_MS;
    return stored.filter((item): item is SpendEntry => isEntry(item, now) && item.at >= since);
  }

  record(entry: SpendEntry, now: number): void {
    const next = [...this.entries(now), entry];
    this.store.set('entries', next.length > SPEND_ENTRY_LIMIT ? next.slice(next.length - SPEND_ENTRY_LIMIT) : next);
  }
}

/**
 * One row per added provider, plus any removed provider with turns in the window. Entries for a
 * provider the catalog no longer lists are left out. Rows sort by cost, highest first, then name.
 */
export function summarizeSpend(
  entries: SpendEntry[],
  providers: Array<{ id: string; name: string; level: TrustLevel; added: boolean; balance: number | null }>,
  now: number
): ConfidentialSpend {
  const rows = new Map<string, ConfidentialSpendRow>();
  for (const provider of providers) {
    if (!provider.added) continue;
    rows.set(provider.id, {
      providerId: provider.id,
      name: provider.name,
      level: provider.level,
      turns: 0,
      turnsWithoutCounts: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      balance: provider.balance,
      removed: false,
    });
  }
  for (const entry of entries) {
    let row = rows.get(entry.providerId);
    if (!row) {
      const provider = providers.find((p) => p.id === entry.providerId);
      if (!provider) continue;
      row = {
        providerId: provider.id,
        name: provider.name,
        level: provider.level,
        turns: 0,
        turnsWithoutCounts: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        balance: null,
        removed: true,
      };
      rows.set(provider.id, row);
    }
    row.turns += 1;
    if (entry.inputTokens === null || entry.outputTokens === null) row.turnsWithoutCounts += 1;
    else {
      row.inputTokens += entry.inputTokens;
      row.outputTokens += entry.outputTokens;
    }
    if (entry.cost !== null) row.cost += entry.cost;
  }
  const sorted = [...rows.values()].sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name));
  return {
    since: now - SPEND_WINDOW_MS,
    rows: sorted,
    totalTurns: sorted.reduce((sum, row) => sum + row.turns, 0),
    totalCost: sorted.reduce((sum, row) => sum + row.cost, 0),
  };
}
