import type { HermesChatUsageSnapshot } from '../../../../shared/types/hermesChat';

export function mapUsageSnapshot(raw: Record<string, unknown>): HermesChatUsageSnapshot {
  const num = (key: string): number | null => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  return {
    contextUsed: num('context_used'),
    contextMax: num('context_max'),
    contextPercent: num('context_percent'),
    contextEstimated:
      typeof raw.context_estimated === 'boolean' ? raw.context_estimated : null,
    avgTps: num('avg_tps'),
    prompt: num('prompt') ?? num('input'),
    completion: num('completion') ?? num('output'),
    input: num('input'),
    output: num('output'),
  };
}
