import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRollingProfiler, type ProtocolSend } from '../perf/rollingProfiler';

let clock = 0;
let profileNumber = 0;
let calls: string[] = [];
let written: Record<string, string> = {};

/** A protocol connection whose Profiler.stop returns profile 1, 2, 3… in order. */
const send: ProtocolSend = vi.fn(async (method: string) => {
  calls.push(method);
  if (method === 'Profiler.stop') return { profile: { n: ++profileNumber } };
  return {};
});

function profiler(sendCommand: ProtocolSend = send) {
  return createRollingProfiler(sendCommand, {
    windowMs: 30_000,
    samplingIntervalUs: 1000,
    youngWindowMs: 10_000,
    now: () => clock,
    writeFile: async (file, contents) => {
      written[file] = contents;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  profileNumber = 0;
  calls = [];
  written = {};
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRollingProfiler', () => {
  it('enables, sets the sampling interval, and starts a window', async () => {
    const p = profiler();
    await p.start();
    expect(calls).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
    expect(send).toHaveBeenCalledWith('Profiler.setSamplingInterval', { interval: 1000 });
    p.stop();
  });

  it('saves only the current window when it is old enough', async () => {
    const p = profiler();
    await p.start();
    clock = 20_000;
    expect(await p.save('/traces/renderer1-x')).toEqual(['/traces/renderer1-x.cpuprofile']);
    expect(JSON.parse(written['/traces/renderer1-x.cpuprofile'])).toEqual({ n: 1 });
    expect(calls.slice(-2)).toEqual(['Profiler.stop', 'Profiler.start']);
    p.stop();
  });

  it('adds the window before when a stall comes early in a fresh one', async () => {
    const p = profiler();
    await p.start();
    clock = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    clock = 32_000;
    expect(await p.save('/traces/main-x')).toEqual([
      '/traces/main-x.cpuprofile',
      '/traces/main-x-before.cpuprofile',
    ]);
    expect(JSON.parse(written['/traces/main-x-before.cpuprofile'])).toEqual({ n: 1 });
    expect(JSON.parse(written['/traces/main-x.cpuprofile'])).toEqual({ n: 2 });
    p.stop();
  });

  it('runs a save and a rotation one after the other, never both at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slowSend: ProtocolSend = async (method) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return method === 'Profiler.stop' ? { profile: {} } : {};
    };
    const p = profiler(slowSend);
    const started = p.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;
    const saved = p.save('/traces/a');
    const rotated = p.rotate();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([saved, rotated]);
    expect(maxInFlight).toBe(1);
    p.stop();
  });

  it('saves nothing and stops rotating once stopped', async () => {
    const p = profiler();
    await p.start();
    p.stop();
    calls = [];
    await vi.advanceTimersByTimeAsync(90_000);
    expect(calls).toEqual([]);
    expect(await p.save('/traces/b')).toEqual([]);
  });

  it('rejects start when the connection refuses, so the caller can log it', async () => {
    const refusing: ProtocolSend = async () => {
      throw new Error('Debugger is not attached');
    };
    await expect(profiler(refusing).start()).rejects.toThrow('Debugger is not attached');
  });

  it('keeps rotating after one rotation fails', async () => {
    let fail = true;
    const flaky: ProtocolSend = async (method) => {
      calls.push(method);
      if (method === 'Profiler.stop' && fail) {
        fail = false;
        throw new Error('target crashed');
      }
      return method === 'Profiler.stop' ? { profile: {} } : {};
    };
    const p = profiler(flaky);
    await p.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.filter((m) => m === 'Profiler.stop')).toHaveLength(2);
    p.stop();
  });
});
