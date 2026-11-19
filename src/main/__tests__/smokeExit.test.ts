import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSmokeExit, failSmokeRun, isSmokeRun } from '../smokeExit';

type Listener = (...args: unknown[]) => void;

function fakeWebContents(rootCount: () => Promise<unknown>) {
  const listeners = new Map<string, Listener>();
  return {
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
    }),
    executeJavaScript: vi.fn(rootCount),
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
}

describe('attachSmokeExit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits 0 once the renderer has mounted into #root', async () => {
    const exit = vi.fn();
    const wc = fakeWebContents(() => Promise.resolve(1));
    attachSmokeExit(wc, { exit, log: vi.fn(), mountDelayMs: 100 });
    wc.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits 1 when #root stays empty', async () => {
    const exit = vi.fn();
    const wc = fakeWebContents(() => Promise.resolve(0));
    attachSmokeExit(wc, { exit, log: vi.fn(), mountDelayMs: 100 });
    wc.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 when reading #root throws', async () => {
    const exit = vi.fn();
    const wc = fakeWebContents(() => Promise.reject(new Error('gone')));
    attachSmokeExit(wc, { exit, log: vi.fn(), mountDelayMs: 100 });
    wc.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 on a failed load and ignores later events', async () => {
    const exit = vi.fn();
    const wc = fakeWebContents(() => Promise.resolve(1));
    attachSmokeExit(wc, { exit, log: vi.fn(), mountDelayMs: 100, timeoutMs: 1_000 });
    wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND');
    wc.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 when the renderer process dies', () => {
    const exit = vi.fn();
    const wc = fakeWebContents(() => Promise.resolve(1));
    attachSmokeExit(wc, { exit, log: vi.fn() });
    wc.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('exits 1 when nothing happens before the timeout', async () => {
    const exit = vi.fn();
    attachSmokeExit(fakeWebContents(() => Promise.resolve(1)), { exit, log: vi.fn(), timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('failSmokeRun', () => {
  it('exits 1', () => {
    const exit = vi.fn();
    failSmokeRun({ exit, log: vi.fn() }, new Error('boom'));
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('isSmokeRun', () => {
  it('is on only for BOUNDARY_SMOKE_EXIT=1', () => {
    expect(isSmokeRun({ BOUNDARY_SMOKE_EXIT: '1' })).toBe(true);
    expect(isSmokeRun({ BOUNDARY_SMOKE_EXIT: 'true' })).toBe(false);
    expect(isSmokeRun({})).toBe(false);
  });
});
