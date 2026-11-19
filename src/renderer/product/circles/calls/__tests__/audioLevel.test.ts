import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchLevel } from '../audioLevel';

const closed = vi.fn(async () => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'AudioContext',
    class {
      createAnalyser() {
        return { fftSize: 0, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.5) };
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      close = closed;
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('watchLevel', () => {
  it('reports the RMS about 15 times a second until stopped', () => {
    const stream = { getAudioTracks: () => [{}] } as unknown as MediaStream;
    const onLevel = vi.fn();
    const stop = watchLevel(stream, onLevel);
    vi.advanceTimersByTime(1000);
    expect(onLevel.mock.calls.length).toBeGreaterThanOrEqual(14);
    expect(onLevel.mock.calls.length).toBeLessThanOrEqual(16);
    expect(onLevel).toHaveBeenLastCalledWith(0.5);
    stop();
    const calls = onLevel.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(onLevel).toHaveBeenCalledTimes(calls);
    expect(closed).toHaveBeenCalled();
  });
});
