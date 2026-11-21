import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChild, fakeSpawn } from '../../__tests__/fakeChild';
import { runLocalScript, SCRIPT_CANCELLED, SCRIPT_NOT_STARTED, SCRIPT_TIMED_OUT } from '../localScript';
import type { RunScriptOptions } from '../types';

function options(extra: Partial<RunScriptOptions> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const full: RunScriptOptions = {
    env: { PATH: '/usr/bin' },
    timeoutMs: 1_000,
    timeoutLine: 'ran too long',
    onStdout: (l) => out.push(l),
    onStderr: (l) => err.push(l),
    ...extra,
  };
  return { full, out, err };
}

describe('runLocalScript', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs bash <script> <args> in the folder with the given env and ignored stdin', async () => {
    const { impl, calls } = fakeSpawn({ stdout: ['one\n\ntwo\n'], stderr: ['wa', 'rn\n'] });
    const { full, out, err } = options();
    const run = runLocalScript('/stack', 'scripts/addon.sh', ['list', '--json'], full, impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(0);
    expect(calls).toEqual([
      {
        command: 'bash',
        args: ['scripts/addon.sh', 'list', '--json'],
        options: { cwd: '/stack', env: { PATH: '/usr/bin' }, stdio: ['ignore', 'pipe', 'pipe'] },
      },
    ]);
    expect(out).toEqual(['one', 'two']);
    expect(err).toEqual(['warn']);
  });

  it('flushes a last line that has no newline', async () => {
    const { impl } = fakeSpawn({ stdout: ['tail'] });
    const { full, out } = options();
    const run = runLocalScript('/stack', 's.sh', [], full, impl);
    await vi.advanceTimersByTimeAsync(0);
    await run;
    expect(out).toEqual(['tail']);
  });

  it("resolves with the script's exit code", async () => {
    const run = runLocalScript('/stack', 's.sh', [], options().full, fakeSpawn({ code: 3 }).impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(3);
  });

  it('reports bash failing to start as 127 with the error on stderr', async () => {
    const { full, err } = options();
    const run = runLocalScript('/stack', 's.sh', [], full, fakeSpawn({ fail: true }).impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(SCRIPT_NOT_STARTED);
    expect(err).toEqual(['spawn bash ENOENT']);
  });

  it('stops a script past its time limit, says so on stderr and resolves with 124', async () => {
    const { impl, kills } = fakeSpawn({ hang: true });
    const { full, err } = options();
    const run = runLocalScript('/stack', 's.sh', [], full, impl);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(kills).toEqual(['SIGTERM']);
    expect(await run).toBe(SCRIPT_TIMED_OUT);
    expect(err.at(-1)).toBe('ran too long');
  });

  it('stops the script when the signal aborts and resolves with 130', async () => {
    const { impl, kills } = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const run = runLocalScript('/stack', 's.sh', [], options({ signal: controller.signal }).full, impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(kills).toEqual([]);
    controller.abort();
    expect(kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(SCRIPT_CANCELLED);
  });

  it('stops at once when the signal is already aborted', async () => {
    const { impl, kills } = fakeSpawn({ hang: true });
    const controller = new AbortController();
    controller.abort();
    const run = runLocalScript('/stack', 's.sh', [], options({ signal: controller.signal }).full, impl);
    expect(kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(SCRIPT_CANCELLED);
  });

  it('writes input to a piped stdin and closes it', async () => {
    const stdin = new PassThrough();
    const child = Object.assign(fakeChild({ closeOnKill: true }), { stdin });
    const written: string[] = [];
    stdin.on('data', (c: Buffer) => written.push(String(c)));
    let stdio: unknown;
    const impl = ((_c: string, _a: string[], o: { stdio: unknown }) => {
      stdio = o.stdio;
      setTimeout(() => child.emit('close', 0), 0);
      return child;
    }) as unknown as typeof spawn;
    const run = runLocalScript('/stack', 's.sh', [], options({ input: '{"a":1}' }).full, impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toBe(0);
    expect(stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(written).toEqual(['{"a":1}']);
    expect(stdin.writableEnded).toBe(true);
  });
});
