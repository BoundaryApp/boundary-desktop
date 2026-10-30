import { describe, expect, it, vi } from 'vitest';
import type { InferenceChainEntryState } from '../../../../../shared/types/inferenceChain';
import {
  opensNewTurn,
  planChainAttempts,
  runChainAttempts,
  shouldFallBack,
  type ChainAttemptOutcome,
} from '../chainAttempts';

function state(key: string, extra: Partial<InferenceChainEntryState> = {}): InferenceChainEntryState {
  return { entry: { slot: 'local' }, key, stale: null, private: true, ...extra };
}

const entries = [state('peer'), state('local'), state('cloud')];
const keys = (plan: InferenceChainEntryState[]) => plan.map((s) => s.key);

describe('shouldFallBack', () => {
  it.each<[ChainAttemptOutcome, boolean]>([
    [{ kind: 'unreachable' }, true],
    [{ kind: 'header-timeout' }, true],
    [{ kind: 'status', status: 429 }, true],
    [{ kind: 'status', status: 503 }, true],
    [{ kind: 'status', status: 400 }, false],
    [{ kind: 'status', status: 401 }, false],
    [{ kind: 'failed-mid-stream' }, false],
    [{ kind: 'served' }, false],
  ])('%o → %s', (outcome, expected) => {
    expect(shouldFallBack(outcome)).toBe(expected);
  });
});

describe('opensNewTurn', () => {
  it('is true only when the last message is the user', () => {
    expect(opensNewTurn([{ role: 'system' }, { role: 'user' }])).toBe(true);
    expect(opensNewTurn([{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }])).toBe(false);
    expect(opensNewTurn([])).toBe(false);
  });
});

describe('planChainAttempts', () => {
  it('starts a new turn from the top', () => {
    expect(keys(planChainAttempts({ entries, stickyKey: 'local', newTurn: true }))).toEqual([
      'peer',
      'local',
      'cloud',
    ]);
  });

  it('keeps a turn on the entry that served it and only moves down', () => {
    expect(keys(planChainAttempts({ entries, stickyKey: 'local', newTurn: false }))).toEqual([
      'local',
      'cloud',
    ]);
  });

  it('starts from the top when the sticky entry left the chain', () => {
    expect(keys(planChainAttempts({ entries, stickyKey: 'gone', newTurn: false }))).toHaveLength(3);
  });

  it('skips stale entries and entries too small for the request', () => {
    const plan = planChainAttempts({
      entries: [
        state('peer', { stale: 'offer-withdrawn' }),
        state('local', { contextLength: 8_192 }),
        state('cloud', { contextLength: 200_000 }),
        state('unknown'),
      ],
      newTurn: true,
      requestTokens: 20_000,
    });
    expect(keys(plan)).toEqual(['cloud', 'unknown']);
  });
});

describe('runChainAttempts', () => {
  it('falls back until an entry serves', async () => {
    const outcomes: Record<string, ChainAttemptOutcome> = {
      peer: { kind: 'unreachable' },
      local: { kind: 'status', status: 429 },
      cloud: { kind: 'served' },
    };
    const result = await runChainAttempts(entries, async (s) => outcomes[s.key]);
    expect(result.ok && result.served.key).toBe('cloud');
    expect(result.tried.map((t) => t.key)).toEqual(['peer', 'local', 'cloud']);
  });

  it('stops at a failure that must not fall back', async () => {
    const attempt = vi.fn(async (): Promise<ChainAttemptOutcome> => ({ kind: 'failed-mid-stream' }));
    const result = await runChainAttempts(entries, attempt);
    expect(result.ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reports every attempt when the chain is exhausted', async () => {
    const result = await runChainAttempts(entries, async () => ({ kind: 'header-timeout' }));
    expect(result).toEqual({
      ok: false,
      tried: entries.map((s) => ({ key: s.key, outcome: { kind: 'header-timeout' } })),
    });
  });
});
