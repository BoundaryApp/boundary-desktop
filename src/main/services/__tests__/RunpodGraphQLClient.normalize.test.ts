import { describe, it, expect } from 'vitest';
import { normalizeWorkerState } from '../infrastructure/RunpodGraphQLClient';

describe('normalizeWorkerState', () => {
  it('uses latest entry from time series array', () => {
    const result = normalizeWorkerState([
      { initializing: 0, throttled: 0, idle: 0, running: 0, unhealthy: 0 },
      { initializing: 3, throttled: 1, idle: 0, running: 0, unhealthy: 0 },
    ]);
    expect(result?.initializing).toBe(3);
    expect(result?.throttled).toBe(1);
  });
});
