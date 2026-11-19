import { spawn } from 'node:child_process';

// The child process behind the stack scripts Boundary runs (crm.sh, addon.sh, budget.sh): output
// split into lines, a time limit, and cancelling through an AbortSignal.

export const SCRIPT_TIMED_OUT = 124;
export const SCRIPT_NOT_STARTED = 127;
export const SCRIPT_CANCELLED = 130;

/**
 * Runs `bash <args>` in `cwd` and passes each non-blank stdout and stderr line on. `input` is
 * written to stdin, which then closes; without it stdin is ignored. Resolves with the exit code:
 * {@link SCRIPT_NOT_STARTED} when bash can't start (its error goes to `onStderr`),
 * {@link SCRIPT_TIMED_OUT} after the limit (with `timeoutLine` on `onStderr`) and
 * {@link SCRIPT_CANCELLED} when `signal` aborted it. Both stops send SIGTERM to bash only; a
 * compose command the script started runs on until it ends.
 */
export function runScriptProcess(options: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  timeoutLine: string;
  signal?: AbortSignal;
  onStdout(line: string): void;
  onStderr(line: string): void;
  spawnImpl?: typeof spawn;
}): Promise<number> {
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const child = spawnImpl('bash', options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(code);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      options.onStderr(options.timeoutLine);
      child.kill('SIGTERM');
    }, options.timeoutMs);
    function onAbort() {
      if (settled || timedOut) return;
      cancelled = true;
      child.kill('SIGTERM');
    }
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const reader = (each: (line: string) => void) => {
      let pending = '';
      return {
        push: (chunk: Buffer | string) => {
          pending += String(chunk);
          const parts = pending.split(/\r?\n/);
          pending = parts.pop() ?? '';
          for (const line of parts) if (line.trim()) each(line);
        },
        flush: () => {
          if (pending.trim()) each(pending);
          pending = '';
        },
      };
    };
    const out = reader(options.onStdout);
    const err = reader(options.onStderr);
    child.stdout?.on('data', out.push);
    child.stderr?.on('data', err.push);
    child.on('error', (error: Error) => {
      options.onStderr(error.message);
      finish(SCRIPT_NOT_STARTED);
    });
    child.on('close', (code: number | null) => {
      out.flush();
      err.flush();
      finish(timedOut ? SCRIPT_TIMED_OUT : cancelled ? SCRIPT_CANCELLED : (code ?? 1));
    });
    if (options.input !== undefined) {
      // A script that exits before reading its input closes the pipe; its exit says what happened.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    }
  });
}
