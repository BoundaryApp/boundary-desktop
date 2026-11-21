import { SCRIPT_CANCELLED, SCRIPT_NOT_STARTED, SCRIPT_TIMED_OUT } from './localScript';
import type { StackCommands } from './types';

/**
 * Runs one command on the host through the user's login shell, as `ssh host 'command'` does.
 * `exitCode` is null when the command ended on a signal or the channel closed without a status.
 * Rejects when the channel can't be opened.
 */
export type SshExec = (
  command: string,
  options: {
    /** Written to stdin, which then closes. Without it stdin closes at once. */
    input?: string;
    /** Signals TERM and closes the channel, after which the host's sshd hangs the command up. */
    signal?: AbortSignal;
    onStdout(chunk: Buffer): void;
    onStderr(chunk: Buffer): void;
  }
) => Promise<{ exitCode: number | null }>;

/** `value` as one POSIX shell word. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `cd <folder> && exec env K=V … <argv>` for any POSIX login shell. Values in `env` go on the
 * host's command line, which other users of that host can see in its process list, so callers
 * put credentials on stdin, never in `env`.
 */
export function remoteCommand(folder: string, argv: string[], env: NodeJS.ProcessEnv = {}): string {
  const assignments = Object.entries(env).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!ENV_NAME.test(key)) throw new Error(`Not an environment variable name: ${key}`);
    return [`${key}=${shellQuote(value)}`];
  });
  const words = [...(assignments.length ? ['env', ...assignments] : []), ...argv.map(shellQuote)];
  return `cd ${shellQuote(folder)} && exec ${words.join(' ')}`;
}

/** Splits chunks into lines and passes each non-blank one on. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  let rest = '';
  const emit = (line: string) => {
    const clean = line.replace(/\r$/, '');
    if (clean.trim()) onLine(clean);
  };
  return {
    push(chunk) {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      lines.forEach(emit);
    },
    end() {
      emit(rest);
      rest = '';
    },
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  /** 124 timed out, 130 cancelled, else the command's status; null when it gave none. */
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
}

/** Runs `command`, keeping its output, with a time limit and cancelling. */
async function run(
  exec: SshExec,
  command: string,
  options: {
    input?: string;
    signal?: AbortSignal;
    timeout?: number;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  } = {}
): Promise<RunResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const outLines = options.onStdoutLine ? lineSplitter(options.onStdoutLine) : null;
  const errLines = options.onStderrLine ? lineSplitter(options.onStderrLine) : null;
  const stop = new AbortController();
  let timedOut = false;
  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true;
        stop.abort();
      }, options.timeout)
    : null;
  const onAbort = () => stop.abort();
  if (options.signal?.aborted) stop.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const { exitCode } = await exec(command, {
      input: options.input,
      signal: stop.signal,
      onStdout: (chunk) => {
        stdout.push(chunk);
        outLines?.push(chunk);
      },
      onStderr: (chunk) => {
        stderr.push(chunk);
        errLines?.push(chunk);
      },
    });
    outLines?.end();
    errLines?.end();
    const text = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (timedOut) return { ...text, code: SCRIPT_TIMED_OUT, cancelled: false, timedOut };
    if (options.signal?.aborted) return { ...text, code: SCRIPT_CANCELLED, cancelled: true, timedOut };
    return { ...text, code: exitCode, cancelled: false, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function failure(what: string, result: RunResult): Error {
  const last = result.stderr.trim().split('\n').at(-1) ?? '';
  const status = result.code === null ? 'without a status' : `with ${result.code}`;
  return Object.assign(new Error(`${what} exited ${status}${last ? `: ${last}` : ''}`), {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  });
}

/**
 * The variables in `env` that this machine's own environment doesn't already hold. A caller that
 * builds a script's environment on top of `process.env` would otherwise send this machine's whole
 * environment, which means nothing on the host, onto the host's command line.
 */
function ownVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => process.env[key] !== value));
}

export interface SshStackCommandsDeps {
  exec: SshExec;
  /** The stack's compose folder on the host, absolute. */
  stackRoot: string;
  /** `COMPOSE_PROFILES` from the host's `.env`, or null when it sets none. */
  envProfiles: () => Promise<string | null>;
}

/**
 * The stack's commands on a host reached over SSH, run from the stack folder there with Docker
 * Engine (CR 0037 R1). The stack runs under its default project name with the host's `.env` as
 * its only configuration (remote stack plan, phase 4), so Boundary passes no compose
 * environment: `scriptEnv` is empty unless a caller adds profiles.
 */
export function sshStackCommands(deps: SshStackCommandsDeps): StackCommands {
  const { exec, stackRoot } = deps;

  const scriptEnv = async (profiles: string[]): Promise<NodeJS.ProcessEnv> => {
    if (!profiles.length) return {};
    const own = (await deps.envProfiles()) || 'core';
    const all = [...own.split(','), ...profiles].map((p) => p.trim()).filter(Boolean);
    return { COMPOSE_PROFILES: [...new Set(all)].join(',') };
  };

  const mustSucceed = async (what: string, command: string, timeout?: number) => {
    const result = await run(exec, command, { timeout });
    if (result.code !== 0) throw failure(what, result);
    return { stdout: result.stdout, stderr: result.stderr };
  };

  return {
    compose: (args, options = {}) =>
      run(exec, remoteCommand(stackRoot, ['docker', 'compose', ...args], ownVariables(options.env ?? {})), {
        timeout: options.timeout,
        signal: options.signal,
      }).then((result) => {
        if (result.code !== 0) throw failure(`docker compose ${args[0] ?? ''}`.trim(), result);
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    composeStreaming: (args, options = {}) =>
      run(exec, remoteCommand(stackRoot, ['docker', 'compose', ...args], ownVariables(options.env ?? {})), {
        input: options.input,
        timeout: options.timeout,
        signal: options.signal,
        onStdoutLine: options.onLine,
        onStderrLine: options.onLine,
      }).then(({ stdout, stderr, code, cancelled }) => ({ stdout, stderr, code, cancelled })),
    scriptEnv,
    scriptCompose: async (args, options = {}) =>
      mustSucceed(
        `docker compose ${args[0] ?? ''}`.trim(),
        remoteCommand(stackRoot, ['docker', 'compose', ...args], await scriptEnv(options.profiles ?? [])),
        options.timeout
      ),
    scriptCli: (args, options = {}) =>
      mustSucceed(`docker ${args[0] ?? ''}`.trim(), remoteCommand(stackRoot, ['docker', ...args]), options.timeout),
    async runScript(script, args, options) {
      let command: string;
      try {
        command = remoteCommand(stackRoot, ['bash', script, ...args], ownVariables(options.env));
      } catch (error) {
        options.onStderr(error instanceof Error ? error.message : String(error));
        return SCRIPT_NOT_STARTED;
      }
      try {
        const result = await run(exec, command, {
          input: options.input,
          signal: options.signal,
          timeout: options.timeoutMs,
          onStdoutLine: options.onStdout,
          onStderrLine: options.onStderr,
        });
        if (result.timedOut) options.onStderr(options.timeoutLine);
        return result.code ?? 1;
      } catch (error) {
        options.onStderr(error instanceof Error ? error.message : String(error));
        return SCRIPT_NOT_STARTED;
      }
    },
  };
}
