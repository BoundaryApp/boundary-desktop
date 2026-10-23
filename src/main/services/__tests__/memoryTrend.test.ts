import { describe, expect, it } from 'vitest';
import { MemoryTrend, fitLine } from '../../perf/memoryTrend';

const rule = () => ({ minGrowth: 30, minRatio: 0.25 });
const minute = 60_000;

function feed(trend: MemoryTrend, values: number[]): void {
  values.forEach((value, i) => trend.add('main:heapUsed', value, 'MB', i * minute));
}

describe('MemoryTrend', () => {
  it('flags a steady climb after the warm-up', () => {
    const trend = new MemoryTrend(rule);
    // Two warm-up samples, then +15MB a minute from 100MB.
    feed(trend, [40, 80, 100, 115, 130, 145, 160]);
    const [found] = trend.newFindings();
    expect(found).toMatchObject({ series: 'main:heapUsed', baseline: 100, now: 160, growing: true });
    expect(found.slopePerMin).toBeCloseTo(15, 0);
  });

  it('ignores garbage-collector sawtooth that goes nowhere', () => {
    const trend = new MemoryTrend(rule);
    feed(trend, [40, 80, 100, 140, 95, 138, 102, 141, 99]);
    expect(trend.newFindings()).toEqual([]);
  });

  it('ignores small growth, however steady', () => {
    const trend = new MemoryTrend(rule);
    feed(trend, [40, 80, 100, 104, 108, 112, 116]);
    expect(trend.newFindings()).toEqual([]);
  });

  it('warns once, then again only when the growth has doubled', () => {
    const trend = new MemoryTrend(rule);
    feed(trend, [40, 80, 100, 115, 130, 145, 160]);
    expect(trend.newFindings()).toHaveLength(1);
    trend.add('main:heapUsed', 175, 'MB', 7 * minute);
    expect(trend.newFindings()).toHaveLength(0);
    for (let i = 8; i <= 12; i++) trend.add('main:heapUsed', 100 + 15 * (i - 2), 'MB', i * minute);
    expect(trend.newFindings()).toHaveLength(1);
  });

  it('forgets a process that has gone', () => {
    const trend = new MemoryTrend(rule);
    trend.add('process:Tab:1', 100, 'MB');
    trend.drop('process:Tab:1');
    expect(trend.seriesNames()).toEqual([]);
  });
});

describe('fitLine', () => {
  it('fits a straight line exactly', () => {
    expect(fitLine([[0, 1], [1, 3], [2, 5]])).toEqual({ slope: 2, r2: 1 });
  });
});
