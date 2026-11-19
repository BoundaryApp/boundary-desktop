import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';

/**
 * Stands in for the ChildProcess that `child_process.spawn` returns. Tests drive it by emitting
 * `data` on `stdout`/`stderr` and `exit`/`close`/`error` on the child, and by setting `exitCode`
 * or `signalCode` the way Node does when the process ends.
 */
export type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: null;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  /** Every signal passed to `kill`, in order. */
  signals: NodeJS.Signals[];
  kill(signal?: NodeJS.Signals): boolean;
};

/**
 * A child that records each `kill`. With `closeOnKill` it emits `close` with a null code on the
 * next tick, as a process killed by a signal does; without it the child ignores the signal and the
 * test ends it by hand.
 */
export function fakeChild(options: { closeOnKill?: boolean } = {}): FakeChild {
  const child: FakeChild = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    killed: false,
    exitCode: null,
    signalCode: null,
    signals: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      child.signals.push(signal);
      child.killed = true;
      if (options.closeOnKill) setTimeout(() => child.emit('close', null), 0);
      return true;
    },
  });
  return child;
}

export type FakeSpawnBehaviour = {
  /** Chunks emitted as `data` on stdout, one event each, before stderr. */
  stdout?: string[];
  /** Chunks emitted as `data` on stderr, one event each. A line split across two chunks tests line buffering. */
  stderr?: string[];
  /** The code `close` carries. Defaults to 0. */
  code?: number | null;
  /** Emit `error` (ENOENT, as when bash is missing) instead of output and `close`. */
  fail?: boolean;
  /** Emit the output but never `close` on its own; the child closes only when killed. */
  hang?: boolean;
};

export type SpawnCall = { command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } };

/**
 * A `spawn` stand-in. Each call returns a fresh `fakeChild({ closeOnKill: true })` that, on the
 * next tick, emits `behaviour`'s output and then `close` or `error`. Use fake timers to step it.
 */
export function fakeSpawn(behaviour: FakeSpawnBehaviour = {}) {
  const calls: SpawnCall[] = [];
  const kills: NodeJS.Signals[] = [];
  const impl = ((command: string, args: string[], options: SpawnCall['options']) => {
    calls.push({ command, args, options });
    const child = fakeChild({ closeOnKill: true });
    const kill = child.kill.bind(child);
    child.kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      kills.push(signal);
      return kill(signal);
    };
    setTimeout(() => {
      if (behaviour.fail) {
        child.emit('error', Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }));
        return;
      }
      for (const chunk of behaviour.stdout ?? []) child.stdout.emit('data', Buffer.from(chunk));
      for (const chunk of behaviour.stderr ?? []) child.stderr.emit('data', Buffer.from(chunk));
      if (!behaviour.hang) child.emit('close', behaviour.code ?? 0);
    }, 0);
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls, kills };
}
