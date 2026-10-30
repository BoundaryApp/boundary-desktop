import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fake utilityProcess child; `exitOnStop` decides whether it answers `stop` by exiting. */
class FakeChild extends EventEmitter {
  exitOnStop = true;
  postMessage = vi.fn((message: { type: string }) => {
    if (message.type === 'stop' && this.exitOnStop) this.emit('exit', 0);
  });
  kill = vi.fn(() => this.emit('exit', null));
}

let lastChild: FakeChild | null = null;
const fork = vi.fn(() => (lastChild = new FakeChild()));
const logged: Array<[string, Record<string, unknown>]> = [];

vi.mock('electron', () => ({
  app: { getPath: () => '/user-data' },
  utilityProcess: { fork },
}));
vi.mock('../../../persistDebugLog', () => ({
  persistDebugLog: (_scope: string, message: string, data: Record<string, unknown>) => logged.push([message, data]),
}));

const KEY = 'ab'.repeat(32);

beforeEach(() => {
  vi.resetModules();
  fork.mockClear();
  lastChild = null;
  logged.length = 0;
  delete process.env.BOUNDARY_CIRCLES_SPIKE;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BOUNDARY_CIRCLES_SPIKE;
});

describe('networkSpikeModeFrom', () => {
  it('reads load, seed and a Hypercore key', async () => {
    const { networkSpikeModeFrom } = await import('../networkSpike');
    expect(networkSpikeModeFrom('load')).toEqual({ kind: 'load' });
    expect(networkSpikeModeFrom(' SEED ')).toEqual({ kind: 'seed' });
    expect(networkSpikeModeFrom(KEY.toUpperCase())).toEqual({ kind: 'replicate', key: KEY });
  });

  it('refuses anything else', async () => {
    const { networkSpikeModeFrom } = await import('../networkSpike');
    expect(networkSpikeModeFrom(undefined)).toBeNull();
    expect(networkSpikeModeFrom('')).toBeNull();
    expect(networkSpikeModeFrom('1')).toBeNull();
    expect(networkSpikeModeFrom(KEY.slice(1))).toBeNull();
  });
});

describe('circles network spike', () => {
  it('does nothing unless BOUNDARY_CIRCLES_SPIKE is set', async () => {
    const spike = await import('../networkSpike');
    spike.startCirclesNetworkSpike();
    expect(fork).not.toHaveBeenCalled();
    await spike.stopCirclesNetworkSpike();
  });

  it('logs a value it does not understand and starts nothing', async () => {
    process.env.BOUNDARY_CIRCLES_SPIKE = 'yes';
    const spike = await import('../networkSpike');
    spike.startCirclesNetworkSpike();
    expect(fork).not.toHaveBeenCalled();
    expect(logged.map(([message]) => message)).toEqual(['BOUNDARY_CIRCLES_SPIKE not understood']);
  });

  it('starts the process once with the mode and a folder in user data', async () => {
    process.env.BOUNDARY_CIRCLES_SPIKE = KEY;
    const spike = await import('../networkSpike');
    spike.startCirclesNetworkSpike();
    spike.startCirclesNetworkSpike();

    expect(fork).toHaveBeenCalledTimes(1);
    expect(lastChild?.postMessage).toHaveBeenCalledWith({
      type: 'start',
      storageDir: '/user-data/circles-spike',
      mode: { kind: 'replicate', key: KEY },
    });
  });

  it('logs whether every addon loaded', async () => {
    process.env.BOUNDARY_CIRCLES_SPIKE = 'load';
    const spike = await import('../networkSpike');
    spike.startCirclesNetworkSpike();
    lastChild!.emit('message', { type: 'addons', loaded: ['rocksdb-native'], missing: ['sodium-native'] });
    lastChild!.emit('message', { type: 'addons', loaded: ['sodium-native'], missing: [] });

    expect(logged.slice(-2)).toEqual([
      ['native addons missing', { loaded: ['rocksdb-native'], missing: ['sodium-native'] }],
      ['all native addons loaded', { loaded: ['sodium-native'], missing: [] }],
    ]);
  });

  it('asks the process to stop and waits for it to exit', async () => {
    process.env.BOUNDARY_CIRCLES_SPIKE = 'seed';
    const spike = await import('../networkSpike');
    spike.startCirclesNetworkSpike();
    const child = lastChild!;

    await spike.stopCirclesNetworkSpike();

    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'stop' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('kills a process that does not exit after stop', async () => {
    vi.useFakeTimers();
    process.env.BOUNDARY_CIRCLES_SPIKE = 'seed';
    const spike = await import('../networkSpike');
    spike.startCirclesNetworkSpike();
    const child = lastChild!;
    child.exitOnStop = false;

    const stopped = spike.stopCirclesNetworkSpike();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(child.kill).toHaveBeenCalledTimes(1);

    // A later start forks a new process.
    spike.startCirclesNetworkSpike();
    expect(fork).toHaveBeenCalledTimes(2);
  });
});
