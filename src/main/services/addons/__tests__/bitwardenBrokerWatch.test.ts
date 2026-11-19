import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BROKER_CHECK_GAP_MS, BROKER_POLL_MS, startBrokerWatch, type BrokerWatchDeps } from '../bitwardenBrokerWatch';

let focusListeners: Set<() => void>;
let active: boolean;
let check: ReturnType<typeof vi.fn<BrokerWatchDeps['check']>>;
let logs: { message: string; data: Record<string, unknown> }[];
let stop: () => void;

const focus = () => [...focusListeners].forEach((listener) => listener());

beforeEach(() => {
  vi.useFakeTimers();
  focusListeners = new Set();
  active = true;
  check = vi.fn(async () => undefined);
  logs = [];
  stop = startBrokerWatch({
    active: () => active,
    check,
    onFocus: (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    log: (message, data) => logs.push({ message, data }),
  });
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('startBrokerWatch', () => {
  it('checks every five minutes', async () => {
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check.mock.calls).toEqual([['poll']]);
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('checks on window focus, at most once a minute', async () => {
    focus();
    focus();
    await vi.advanceTimersByTimeAsync(BROKER_CHECK_GAP_MS - 1);
    focus();
    expect(check.mock.calls).toEqual([['focus']]);
    await vi.advanceTimersByTimeAsync(1);
    focus();
    expect(check.mock.calls).toEqual([['focus'], ['focus']]);
  });

  it('a poll within a minute of a focus check is skipped', async () => {
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS - 30_000);
    focus();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check.mock.calls).toEqual([['focus']]);
  });

  it('doesn\'t start a check while one is running', async () => {
    let finish: () => void = () => undefined;
    check.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    focus();
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does nothing while Bitwarden is inactive', async () => {
    active = false;
    focus();
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS * 3);
    expect(check).not.toHaveBeenCalled();
  });

  it('logs a check that rejects by error name and keeps polling', async () => {
    check.mockRejectedValueOnce(new TypeError('secret'));
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(logs).toEqual([{ message: 'broker check failed', data: { trigger: 'poll', error: 'TypeError' } }]);
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('stops listening and polling when stopped', async () => {
    stop();
    focus();
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS * 3);
    expect(check).not.toHaveBeenCalled();
    expect(focusListeners.size).toBe(0);
  });
});
