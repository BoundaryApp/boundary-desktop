import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportFatalErrors } from '../networkFatal';

function setup() {
  const host = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const log = vi.fn();
  const diag = vi.fn();
  const printed: unknown[] = [];
  reportFatalErrors(host, { log, diag, print: (error) => void printed.push(error) });
  return { host, log, diag, printed };
}

describe('reportFatalErrors', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('logs an uncaught exception, prints it, and exits with 1 once the message has had time to go', () => {
    const { host, log, diag, printed } = setup();
    const error = new TypeError('cannot read properties of undefined');
    host.emit('uncaughtException', error);

    expect(log).toHaveBeenCalledWith('uncaught error', {
      kind: 'exception',
      name: 'TypeError',
      error: 'cannot read properties of undefined',
      stack: expect.stringContaining('TypeError: cannot read properties of undefined'),
    });
    expect(diag).toHaveBeenCalledWith('net.uncaught', { kind: 'exception', name: 'TypeError' });
    expect(printed).toEqual([error]);
    expect(host.exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(host.exit).toHaveBeenCalledWith(1);
  });

  it('treats an unhandled rejection with a non-Error reason as fatal too', () => {
    const { host, log, diag } = setup();
    host.emit('unhandledRejection', 'socket closed');

    expect(log).toHaveBeenCalledWith('uncaught error', { kind: 'rejection', name: 'string', error: 'socket closed', stack: null });
    expect(diag).toHaveBeenCalledWith('net.uncaught', { kind: 'rejection', name: 'string' });
    vi.advanceTimersByTime(100);
    expect(host.exit).toHaveBeenCalledTimes(1);
  });

  it('reports only the first of several errors and exits once', () => {
    const { host, log } = setup();
    host.emit('uncaughtException', new Error('first'));
    host.emit('uncaughtException', new Error('second'));

    expect(log).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(host.exit).toHaveBeenCalledTimes(1);
  });

  it('still exits when reporting throws, as when the parent port is gone', () => {
    const host = Object.assign(new EventEmitter(), { exit: vi.fn() });
    const log = vi.fn(() => {
      throw new Error('port closed');
    });
    reportFatalErrors(host, { log, diag: vi.fn(), print: () => undefined });
    host.emit('uncaughtException', new Error('boom'));

    vi.advanceTimersByTime(100);
    expect(host.exit).toHaveBeenCalledWith(1);
  });
});
