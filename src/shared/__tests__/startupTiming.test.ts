import { describe, expect, it } from 'vitest';
import {
  STACK_UP_PROGRESS,
  estimateMinutes,
  estimateText,
  expectedOffsets,
  expectedServiceOffset,
  startRemaining,
  timedProgress,
  type StartOffsets,
  type StartTiming,
} from '../startupTiming';

const RC13_RUN: StartOffsets = {
  prepared: 500,
  toolsStarting: 2_000,
  apiBootstrapDone: 128_000,
  browserBootstrapDone: 210_000,
  hermesStarted: 212_000,
  stackUp: 267_000,
};

const timing = (reached: StartOffsets = {}, runs: StartOffsets[] = [RC13_RUN]): StartTiming => ({
  startedAt: 0,
  kind: 'newContainers',
  expected: expectedOffsets('newContainers', runs),
  expectedServices: {},
  reached,
  fromHistory: true,
});

const upTo = (...names: (keyof StartOffsets)[]): StartOffsets =>
  Object.fromEntries(names.map((name) => [name, RC13_RUN[name]]));

describe('expectedOffsets', () => {
  it('takes the median of finished runs', () => {
    const offsets = expectedOffsets('relaunch', [
      { stackUp: 100_000 },
      { stackUp: 300_000 },
      { stackUp: 200_000 },
    ]);
    expect(offsets.stackUp).toBe(200_000);
  });

  it('falls back to the defaults with no finished run', () => {
    expect(expectedOffsets('relaunch', [{ prepared: 5 }])).toEqual(expectedOffsets('relaunch', []));
  });

  it('gives a milestone no run reported the time of the one before', () => {
    const offsets = expectedOffsets('relaunch', [{ prepared: 1_000, stackUp: 50_000 }]);
    expect(offsets.apiBootstrapDone).toBe(1_000);
    expect(offsets.hermesStarted).toBe(1_000);
  });
});

describe('timedProgress', () => {
  it('stays close to the share of time passed on a typical start', () => {
    const checkpoints: [number, StartOffsets][] = [
      [36_000, upTo('prepared', 'toolsStarting')],
      [128_000, upTo('prepared', 'toolsStarting', 'apiBootstrapDone')],
      [240_000, upTo('prepared', 'toolsStarting', 'apiBootstrapDone', 'browserBootstrapDone', 'hermesStarted')],
    ];
    for (const [at, reached] of checkpoints) {
      expect(timedProgress(timing(reached), at)).toBeCloseTo((at / 267_000) * STACK_UP_PROGRESS, 1);
    }
  });

  it('stops short of a milestone that runs late', () => {
    const fill = timedProgress(timing(upTo('prepared', 'toolsStarting')), 60 * 60_000);
    expect(fill).toBeLessThan((128_000 / 267_000) * STACK_UP_PROGRESS);
    expect(fill).toBeGreaterThan(fillAt(100_000));
  });

  it('jumps ahead when a milestone comes early', () => {
    const before = timedProgress(timing(), 40_000);
    const after = timedProgress(timing({ apiBootstrapDone: 40_000 }), 40_000);
    expect(after).toBeGreaterThan(before + 0.2);
  });

  it('holds at the end of its span once the stack is up', () => {
    expect(timedProgress(timing({ stackUp: 267_000 }), 300_000)).toBe(STACK_UP_PROGRESS);
  });

  it('skips milestones with no length of their own', () => {
    const runs = [{ prepared: 1_000, stackUp: 50_000 }];
    const fill = timedProgress(timing({ prepared: 1_000 }, runs), 25_000);
    expect(fill).toBeGreaterThan(0.4);
    expect(fill).toBeLessThan(0.55);
  });
});

function fillAt(at: number): number {
  return timedProgress(timing(upTo('prepared', 'toolsStarting')), at);
}

describe('startRemaining', () => {
  it('scales what is left by how this run compares so far', () => {
    const onPace = startRemaining(timing({ apiBootstrapDone: 128_000 }), 128_000);
    const slow = startRemaining(timing({ apiBootstrapDone: 192_000 }), 192_000);
    expect(onPace.remainingMs).toBeCloseTo(139_000, -3);
    expect(slow.remainingMs).toBeCloseTo(208_500, -3);
  });

  it('ignores the pace of a milestone too early to mean anything', () => {
    const { remainingMs } = startRemaining(timing({ prepared: 5_000 }), 5_000);
    expect(remainingMs).toBeCloseTo(266_500, -3);
  });

  it('reports overdue well past the expected end', () => {
    const reached = upTo('prepared', 'toolsStarting');
    expect(startRemaining(timing(reached), 280_000).overdue).toBe(false);
    expect(startRemaining(timing(reached), 400_000).overdue).toBe(true);
  });
});

describe('estimate wording', () => {
  it.each([
    [10_000, 'Almost ready'],
    [60_000, 'About a minute left'],
    [120_000, 'A couple of minutes left'],
    [240_000, 'About 4 minutes left'],
  ])('%i ms left reads as %s', (remaining, text) => {
    expect(estimateText(estimateMinutes(remaining))).toBe(text);
  });
});

describe('expectedServiceOffset', () => {
  it('prefers this Mac\'s history, then the milestone, then the stack being up', () => {
    const run = { ...timing(), expectedServices: { 'boundary-searxng': 5_000 } };
    expect(expectedServiceOffset(run, 'boundary-searxng')).toBe(5_000);
    expect(expectedServiceOffset(run, 'boundary-hermes')).toBe(run.expected.hermesStarted);
    expect(expectedServiceOffset(run, 'boundary-hermes-webui')).toBe(run.expected.stackUp);
  });
});
