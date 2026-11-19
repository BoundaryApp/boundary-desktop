import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_SETTINGS, DEFAULT_TURN_PROFILE, meetsLevel, meetsPrecision } from '../confidential';

describe('confidential defaults', () => {
  it('match the spec', () => {
    expect(DEFAULT_POOL_SETTINGS).toEqual({
      chatFloor: 'B',
      privateFloor: 'A',
      lowestPrecision: 'fp8',
      allowUnstatedPrecision: true,
      preferOneProvider: false,
      preferThresholdPercent: 20,
    });
    expect(DEFAULT_TURN_PROFILE).toEqual({ inputTokens: 75_000, cachedShare: 0.6, outputTokens: 2_500 });
  });

  it('orders levels A > B > C', () => {
    expect(meetsLevel('A', 'B')).toBe(true);
    expect(meetsLevel('B', 'B')).toBe(true);
    expect(meetsLevel('C', 'B')).toBe(false);
    expect(meetsLevel('B', 'A')).toBe(false);
  });

  it('orders precision bf16 > fp8 > fp4', () => {
    expect(meetsPrecision('bf16', 'fp8')).toBe(true);
    expect(meetsPrecision('fp8', 'fp8')).toBe(true);
    expect(meetsPrecision('fp4', 'fp8')).toBe(false);
  });
});
