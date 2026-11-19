import { afterEach, describe, expect, it, vi } from 'vitest';

const { persistDebugLog } = vi.hoisted(() => ({ persistDebugLog: vi.fn() }));
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog }));

import { notifyHermesReplaced, onBeforeStackUp, onHermesReplaced, runBeforeStackUp } from '../hermesLifecycle';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const unsubscribers: Array<() => void> = [];
const track = (off: () => void) => {
  unsubscribers.push(off);
  return off;
};

afterEach(() => {
  for (const off of unsubscribers.splice(0)) off();
  persistDebugLog.mockReset();
});

describe('onHermesReplaced', () => {
  it('calls each listener with the reason', () => {
    const a = vi.fn();
    const b = vi.fn();
    track(onHermesReplaced(a));
    track(onHermesReplaced(b));
    notifyHermesReplaced('web-search');
    expect(a).toHaveBeenCalledWith('web-search');
    expect(b).toHaveBeenCalledWith('web-search');
  });

  it('stops calling a listener after it unsubscribes', () => {
    const listener = vi.fn();
    const off = onHermesReplaced(listener);
    off();
    notifyHermesReplaced('start');
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not wait for a listener', () => {
    track(onHermesReplaced(() => new Promise<void>(() => {})));
    expect(() => notifyHermesReplaced('start')).not.toThrow();
  });

  it('logs a rejecting listener by reason and error name, and still calls the others', async () => {
    const after = vi.fn();
    track(onHermesReplaced(() => Promise.reject(new TypeError('secret text'))));
    track(onHermesReplaced(after));
    notifyHermesReplaced('addon-reload');
    await flush();
    expect(after).toHaveBeenCalledWith('addon-reload');
    expect(persistDebugLog).toHaveBeenCalledWith('assistant-stack', 'hermes-replaced listener failed', {
      reason: 'addon-reload',
      error: 'TypeError',
    });
  });

  it('logs a listener that throws instead of throwing', () => {
    track(
      onHermesReplaced(() => {
        throw new RangeError('x');
      })
    );
    expect(() => notifyHermesReplaced('project-mounts')).not.toThrow();
    expect(persistDebugLog).toHaveBeenCalledWith('assistant-stack', 'hermes-replaced listener failed', {
      reason: 'project-mounts',
      error: 'RangeError',
    });
  });
});

describe('runBeforeStackUp', () => {
  it('awaits the listeners in order', async () => {
    const order: string[] = [];
    track(
      onBeforeStackUp(async () => {
        await Promise.resolve();
        order.push('first');
      })
    );
    track(onBeforeStackUp(async () => void order.push('second')));
    await runBeforeStackUp();
    expect(order).toEqual(['first', 'second']);
  });

  it('propagates a rejection and skips the later listeners', async () => {
    const later = vi.fn(async () => {});
    track(onBeforeStackUp(() => Promise.reject(new Error('no'))));
    track(onBeforeStackUp(later));
    await expect(runBeforeStackUp()).rejects.toThrow('no');
    expect(later).not.toHaveBeenCalled();
  });

  it('skips a listener after it unsubscribes', async () => {
    const listener = vi.fn(async () => {});
    onBeforeStackUp(listener)();
    await runBeforeStackUp();
    expect(listener).not.toHaveBeenCalled();
  });
});
