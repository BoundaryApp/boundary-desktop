import { describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot } from '../../../../shared/assistantStackLifecycle';
import { STARTUP_NOTICE_MIN_MS, createStartupNotifier } from '../startupNotice';

function setup(inBackground = true) {
  let now = 0;
  const notify = vi.fn();
  const listener = createStartupNotifier({
    now: () => now,
    inBackground: () => inBackground,
    notify,
  });
  return {
    notify,
    listener,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('createStartupNotifier', () => {
  it('notifies when a long start finishes in the background', () => {
    const { notify, listener, advance } = setup();
    listener(createLifecycleSnapshot('starting'));
    advance(STARTUP_NOTICE_MIN_MS);
    listener(createLifecycleSnapshot('ready'));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Your assistant is ready' }));
  });

  it('times the start from its first starting update, not the latest one', () => {
    const { notify, listener, advance } = setup();
    listener(createLifecycleSnapshot('starting'));
    advance(STARTUP_NOTICE_MIN_MS - 1_000);
    listener(createLifecycleSnapshot('starting', { message: 'still going' }));
    advance(2_000);
    listener(createLifecycleSnapshot('ready'));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a quick start', () => {
    const { notify, listener, advance } = setup();
    listener(createLifecycleSnapshot('starting'));
    advance(3_000);
    listener(createLifecycleSnapshot('ready'));
    expect(notify).not.toHaveBeenCalled();
  });

  it('stays quiet while Boundary is focused', () => {
    const { notify, listener, advance } = setup(false);
    listener(createLifecycleSnapshot('starting'));
    advance(STARTUP_NOTICE_MIN_MS * 4);
    listener(createLifecycleSnapshot('ready'));
    expect(notify).not.toHaveBeenCalled();
  });

  it('says what went wrong when a long start fails', () => {
    const { notify, listener, advance } = setup();
    listener(createLifecycleSnapshot('starting'));
    advance(STARTUP_NOTICE_MIN_MS);
    listener(createLifecycleSnapshot('error', { error: 'fetch failed' }));
    expect(notify).toHaveBeenCalledWith({
      title: 'Your assistant didn’t start',
      body: 'Couldn’t download your tools',
    });
  });

  it('does not notify for ready updates outside a start', () => {
    const { notify, listener, advance } = setup();
    advance(STARTUP_NOTICE_MIN_MS * 2);
    listener(createLifecycleSnapshot('ready'));
    listener(createLifecycleSnapshot('ready'));
    expect(notify).not.toHaveBeenCalled();
  });
});
