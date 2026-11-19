import { describe, expect, it } from 'vitest';
import { ringSamples } from '../ringSound';

describe('ringSamples', () => {
  const rate = 8_000;
  const samples = ringSamples(rate);
  const loudest = (from: number, to: number) => Math.max(...Array.from(samples.subarray(Math.round(from * rate), Math.round(to * rate)), Math.abs));

  it('is three seconds: two chimes, then quiet until the loop starts again', () => {
    expect(samples.length).toBe(3 * rate);
    expect(loudest(0, 0.45)).toBeGreaterThan(0.05);
    expect(loudest(0.55, 1)).toBeGreaterThan(0.05);
    expect(loudest(1.01, 3)).toBe(0);
  });

  it('starts and ends silent, so the loop does not click', () => {
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
  });

  it('stays well inside full scale', () => {
    expect(loudest(0, 3)).toBeLessThan(0.5);
  });
});
