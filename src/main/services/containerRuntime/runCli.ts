import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerRuntime } from './types';

const defaultExecFileAsync = promisify(execFile);

/** How long a timed-out Compose gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5_000;
/** How long to wait for stdio to close after a timed-out Compose has exited. */
const CLOSE_GRACE_MS = 1_000;

export type RunCliOptions = {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  execFile?: typeof defaultExecFileAsync;
};

export type RunComposeStreamingOptions = {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Written to stdin, which is then closed. Without it stdin is not connected. */
  input?: string;
  /** Injected for tests. */
  spawnFn?: typeof spawn;
};

export function composeArgv(runtime: ContainerRuntime, args: string[]): string[] {
  return [...runtime.composeArgv, ...args];
}

async function execRuntime(
  runtime: ContainerRuntime,
  file: string,
  args: string[],
  options: RunCliOptions
): Promise<{ stdout: string; stderr: string }> {
  const exec = options.execFile ?? defaultExecFileAsync;
  const { stdout, stderr } = await exec(file, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    env: { ...runtime.env, ...options.env },
    encoding: 'utf8',
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export async function runCli(
  runtime: ContainerRuntime,
  args: string[],
  options: RunCliOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return execRuntime(runtime, runtime.cliPath, args, options);
}

/**
 * Run Compose against the resolved runtime.
 * Uses `composeBinaryPath` (standalone Compose v2) when present; otherwise
 * `cliPath` + `composeArgv` (e.g. `docker compose …`).
 */
export async function runCompose(
  runtime: ContainerRuntime,
  args: string[],
  options: RunCliOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  if (runtime.composeBinaryPath) return execRuntime(runtime, runtime.composeBinaryPath, args, options);
  return runCli(runtime, composeArgv(runtime, args), options);
}

function attachLineBuffer(
  chunk: string,
  pending: { value: string },
  onLine?: (line: string) => void
): void {
  pending.value += chunk;
  let idx: number;
  while ((idx = pending.value.indexOf('\n')) !== -1) {
    const line = pending.value.slice(0, idx);
    pending.value = pending.value.slice(idx + 1);
    onLine?.(line.replace(/\r$/, ''));
  }
}

/**
 * Spawn Compose and stream stdout/stderr line-by-line (for `--progress=json`).
 */
export async function runComposeStreaming(
  runtime: ContainerRuntime,
  args: string[],
  options: RunComposeStreamingOptions = {}
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const spawnFn = options.spawnFn ?? spawn;
  const command = runtime.composeBinaryPath ?? runtime.cliPath;
  const argv = runtime.composeBinaryPath ? args : composeArgv(runtime, args);

  return new Promise((resolve, reject) => {
    const child = spawnFn(command, argv, {
      cwd: options.cwd,
      env: { ...runtime.env, ...options.env },
      stdio: [options.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (options.input != null) {
      child.stdin?.on('error', () => undefined); // a child that exits early closes the pipe
      child.stdin?.end(options.input);
    }

    let stdout = '';
    let stderr = '';
    const stdoutPending = { value: '' };
    const stderrPending = { value: '' };
    // Compose exits 130 on SIGTERM, so the code alone can't tell a timeout from an interrupt.
    let timedOut = false;

    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      return true;
    };
    const finish = (code: number | null) => {
      if (!settle()) return;
      if (stdoutPending.value) {
        options.onStdoutLine?.(stdoutPending.value.replace(/\r$/, ''));
      }
      if (stderrPending.value) {
        options.onStderrLine?.(stderrPending.value.replace(/\r$/, ''));
      }
      resolve({ stdout, stderr, code, timedOut });
    };

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const timer =
      options.timeout != null
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
              // `child.killed` only says a signal was sent; these say whether it exited.
              if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
              }
            }, KILL_GRACE_MS);
          }, options.timeout)
        : undefined;

    child.stdout?.on('data', (buf: Buffer | string) => {
      const text = buf.toString();
      stdout += text;
      attachLineBuffer(text, stdoutPending, options.onStdoutLine);
    });
    child.stderr?.on('data', (buf: Buffer | string) => {
      const text = buf.toString();
      stderr += text;
      attachLineBuffer(text, stderrPending, options.onStderrLine);
    });
    child.on('error', (err) => {
      if (settle()) reject(err);
    });
    child.on('exit', (code) => {
      // After a timeout, a grandchild can keep stdout/stderr open and hold back
      // `close`, so stop waiting for it shortly after the child itself exits.
      if (timedOut && !settled) {
        closeTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code);
        }, CLOSE_GRACE_MS);
      }
    });
    child.on('close', (code) => finish(code));
  });
}
