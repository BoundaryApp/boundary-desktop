import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ContainerRuntime } from './types';

const defaultExecFileAsync = promisify(execFile);

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

export async function runCli(
  runtime: ContainerRuntime,
  args: string[],
  options: RunCliOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const exec = options.execFile ?? defaultExecFileAsync;
  const { stdout, stderr } = await exec(runtime.cliPath, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    env: { ...runtime.env, ...options.env },
    encoding: 'utf8',
  });
  return { stdout: String(stdout), stderr: String(stderr) };
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
  const exec = options.execFile ?? defaultExecFileAsync;
  if (runtime.composeBinaryPath) {
    const { stdout, stderr } = await exec(runtime.composeBinaryPath, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      env: { ...runtime.env, ...options.env },
      encoding: 'utf8',
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
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

    const timer =
      options.timeout != null
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!child.killed) {
                child.kill('SIGKILL');
              }
            }, 5_000).unref?.();
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
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (stdoutPending.value) {
        options.onStdoutLine?.(stdoutPending.value.replace(/\r$/, ''));
      }
      if (stderrPending.value) {
        options.onStderrLine?.(stderrPending.value.replace(/\r$/, ''));
      }
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
