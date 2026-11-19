import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }));
vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

import { MacCalendarHelper } from '../macCalendarHelper';
import { MacHelperError } from '../macCalendarProtocol';
import { serveFakeCalendarHelper } from './fixtures/fake-calendar-helper.mjs';

const fakeScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-calendar-helper.mjs'
);

type LogCall = { msg: string; data?: Record<string, unknown> };

/**
 * An in-process child running the fake helper's behaviour over PassThrough streams, so a test
 * needs no node start-up. Like a real child, `kill` marks it killed and it emits `close` once,
 * after its streams end.
 */
class FakeHelperChild extends EventEmitter {
  private static nextPid = 1;
  readonly pid = FakeHelperChild.nextPid++;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private closed = false;

  constructor(behaviour: string) {
    super();
    serveFakeCalendarHelper(behaviour, this.stdin, this.stdout, () => this.exit(0, null));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.closed) return false;
    this.killed = true;
    this.exit(null, signal);
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }
}

/** A helper whose children are FakeHelperChild: protocol, timeouts and crash counting. */
function makeHelper(behaviour: string) {
  const children: FakeHelperChild[] = [];
  const logs: LogCall[] = [];
  const spawnFn = (() => {
    const child = new FakeHelperChild(behaviour);
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  const helper = new MacCalendarHelper({
    binaryPath: 'fake-calendar-helper',
    spawn: spawnFn,
    log: (msg, data) => logs.push({ msg, data }),
  });
  return { helper, children, logs };
}

/** A helper that spawns the fake script with node: stdio framing and real process lifecycle. */
function makeRealHelper(behaviour: string, binaryPath = process.execPath) {
  const children: ChildProcess[] = [];
  const logs: LogCall[] = [];
  const spawnFn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn;
  const helper = new MacCalendarHelper({
    binaryPath,
    args: [fakeScript, behaviour],
    spawn: spawnFn,
    log: (msg, data) => logs.push({ msg, data }),
  });
  return { helper, children, logs };
}

describe('MacCalendarHelper', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the helper on first request and matches replies by id', async () => {
    const { helper, children } = makeRealHelper('ok');
    expect(helper.state()).toBe('idle');
    expect(children).toHaveLength(0);
    const [a, b] = await Promise.all([
      helper.request<{ access: string }>('status'),
      helper.request<unknown[]>('listCalendars'),
    ]);
    expect(a).toEqual({ access: 'granted' });
    expect(b).toHaveLength(2);
    expect(children).toHaveLength(1);
    expect(helper.state()).toBe('running');
    helper.stop();
  });

  /** Sends a `getEvent` the `hang` fake never answers and lets it time out. */
  async function hangOnce(helper: MacCalendarHelper): Promise<MacHelperError> {
    const outcome = helper.request('getEvent', { id: 'ev-1' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    return (await outcome) as MacHelperError;
  }

  it('rejects a hung request with timeout after 10 s, kills the helper and starts a new one', async () => {
    const { helper, children } = makeHelper('hang');
    const outcome = helper.request('getEvent', { id: 'ev-1' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(children[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await outcome;
    expect(error).toBeInstanceOf(MacHelperError);
    expect((error as MacHelperError).code).toBe('timeout');
    expect(children[0].killed).toBe(true);
    expect(children).toHaveLength(2);
    expect(helper.state()).toBe('running');
    await expect(helper.request('status')).resolves.toEqual({ access: 'granted' });
    helper.stop();
  });

  it('gives listEvents and search 45 s before timing out, below Hermes\'s 60 s call timeout', async () => {
    const { helper, children } = makeHelper('hang');
    const outcome = helper.request('search', { query: 'x' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(children[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await outcome) as MacHelperError).code).toBe('timeout');
    expect(children[0].killed).toBe(true);
    helper.stop();
  });

  it('lets a 30 s listEvents finish without killing the helper', async () => {
    const { helper, children } = makeHelper('slow-reads');
    const reply = helper.request('listEvents', {});
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(reply).resolves.toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
    helper.stop();
  });

  it('times a request waiting behind a slow one from when the helper reaches it', async () => {
    const { helper, children } = makeHelper('slow-reads');
    const list = helper.request('listEvents', {});
    const status = helper.request('status');
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(list).resolves.toHaveLength(1);
    await expect(status).resolves.toEqual({ access: 'granted' });
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
    helper.stop();
  });

  it('reports stopped after a second hang, so Restart shows', async () => {
    const { helper, children } = makeHelper('hang');
    expect((await hangOnce(helper)).code).toBe('timeout');
    expect((await hangOnce(helper)).code).toBe('timeout');
    expect(children).toHaveLength(2);
    expect(children[1].killed).toBe(true);
    expect(helper.state()).toBe('stopped');
    expect(((await helper.request('status').catch((e: unknown) => e)) as MacHelperError).code).toBe('stopped');
    helper.restart();
    await expect(helper.request('status')).resolves.toEqual({ access: 'granted' });
    helper.stop();
  });

  it('rejects other waiting requests when it kills a hung helper', async () => {
    const { helper } = makeHelper('hang');
    const first = helper.request('getEvent', { id: 'a' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    const second = helper.request('getEvent', { id: 'b' }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(((await first) as MacHelperError).code).toBe('timeout');
    expect(((await second) as MacHelperError).code).toBe('internal');
    helper.stop();
  });

  it('clears the crash count after a healthy run, so a later hang restarts again', async () => {
    const { helper, children } = makeHelper('hang');
    await hangOnce(helper);
    expect(children).toHaveLength(2);
    // The second helper serves for over a minute before it hangs.
    await expect(helper.request('status')).resolves.toEqual({ access: 'granted' });
    await vi.advanceTimersByTimeAsync(60_000);
    await hangOnce(helper);
    expect(children).toHaveLength(3);
    expect(helper.state()).toBe('running');
    // The third helper hangs at once: that is its one restart used, so it stops.
    await hangOnce(helper);
    expect(helper.state()).toBe('stopped');
    expect(children).toHaveLength(3);
  });

  it('does not time out requestAccess, which waits for the person to answer', async () => {
    const { helper, children } = makeHelper('hold-access');
    let settled = false;
    const reply = helper.request('requestAccess').finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
    expect(helper.state()).toBe('running');
    await helper.request('release' as never);
    await expect(reply).resolves.toEqual({ access: 'granted' });
    helper.stop();
  });

  it('restarts once after a crash, then reports stopped and rejects with stopped', async () => {
    const { helper, children } = makeHelper('crash-after-1');
    await helper.request('status');
    await once(children[0], 'close');
    expect(children).toHaveLength(2);
    expect(helper.state()).toBe('running');
    await helper.request('status');
    await once(children[1], 'close');
    expect(children).toHaveLength(2);
    expect(helper.state()).toBe('stopped');
    const error = await helper.request('status').catch((e: unknown) => e);
    expect((error as MacHelperError).code).toBe('stopped');
  });

  it('restart() clears the crash count and starts the helper again', async () => {
    const { helper, children } = makeHelper('crash-after-1');
    await helper.request('status');
    await once(children[0], 'close');
    await helper.request('status');
    await once(children[1], 'close');
    expect(helper.state()).toBe('stopped');
    helper.restart();
    expect(helper.state()).toBe('running');
    await expect(helper.request('status')).resolves.toEqual({ access: 'granted' });
    helper.stop();
  });

  it('rejects every in-flight request when the helper exits', async () => {
    const { helper, children } = makeRealHelper('hang');
    const one = helper.request('getEvent', { id: 'a' }).catch((e: unknown) => e);
    const two = helper.request('getEvent', { id: 'b' }).catch((e: unknown) => e);
    await helper.request('status');
    children[0].kill('SIGKILL');
    const errors = (await Promise.all([one, two])) as MacHelperError[];
    expect(errors.map((e) => e.code)).toEqual(['internal', 'internal']);
    helper.stop();
  });

  it('ignores a malformed line and logs only its length', async () => {
    const { helper, logs } = makeHelper('garbage');
    await expect(helper.request('status')).resolves.toEqual({ access: 'granted' });
    const line = logs.find((l) => l.data && 'length' in l.data);
    expect(line?.data).toEqual({ length: 'not json at all'.length });
    expect(JSON.stringify(logs)).not.toContain('not json at all');
    helper.stop();
  });

  it('reports missing, without spawning in a loop, when the binary does not exist', async () => {
    const { helper, children } = makeRealHelper('ok', '/nonexistent/boundary-calendar-helper');
    const first = (await helper.request('status').catch((e: unknown) => e)) as MacHelperError;
    expect(first.code).toBe('missing');
    expect(helper.state()).toBe('missing');
    const second = (await helper.request('status').catch((e: unknown) => e)) as MacHelperError;
    expect(second.code).toBe('missing');
    expect(children).toHaveLength(1);
  });

  it('rejects with the helper error code', async () => {
    const { helper } = makeHelper('denied');
    const error = (await helper.request('listCalendars').catch((e: unknown) => e)) as MacHelperError;
    expect(error.code).toBe('denied');
    helper.stop();
  });

  it('calls onChanged listeners for an unprompted changed event', async () => {
    const { helper } = makeHelper('ok');
    const cb = vi.fn();
    const off = helper.onChanged(cb);
    await helper.request('emitChanged' as never);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    await helper.request('emitChanged' as never);
    expect(cb).toHaveBeenCalledTimes(1);
    helper.stop();
  });

  it('stop() rejects pending requests with stopped', async () => {
    const { helper } = makeHelper('hang');
    const pending = helper.request('getEvent', { id: 'a' }).catch((e: unknown) => e);
    helper.stop();
    expect(((await pending) as MacHelperError).code).toBe('stopped');
    expect(helper.state()).toBe('stopped');
  });

  it('never puts request params or reply results in log data', async () => {
    const { helper, logs } = makeHelper('garbage');
    await helper.request('getEvent', { id: 'SecretParamValue' });
    await helper.request('listEvents', { calendarIds: ['cal-1'] });
    const text = JSON.stringify(logs);
    expect(text).not.toContain('SecretParamValue');
    expect(text).not.toContain('Secret Title');
    helper.stop();
  });
});
