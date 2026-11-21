import type { StackCommands } from '../stackHost/types';
import type { TwentyConnectInput, TwentyConnectResult } from '../../../shared/types/addons';

export type { TwentyConnectInput, TwentyConnectResult };

const DEFAULT_TIMEOUT_MS = 600_000;
/** `crm.sh add` checks up to two keys, each with a 20 s curl. */
const CONNECT_TIMEOUT_MS = 120_000;
const ERROR_PREFIX = '[crm] ERROR: ';

/**
 * Runs `bash scripts/crm.sh <args>` in the stack folder with stdin closed and passes each output
 * line on. Resolves with the exit code and every line: 127 when bash can't start, 124 after
 * the timeout, 130 when `signal` aborted it. Both stops send SIGTERM
 * to bash only; a compose command the script started runs on until it ends.
 */
export function runCrmScript(options: {
  runScript: StackCommands['runScript'];
  args: string[];
  env: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ code: number; lines: string[] }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lines: string[] = [];
  const onLine = (line: string) => {
    lines.push(line);
    options.onLine?.(line);
  };
  return options.runScript('scripts/crm.sh', options.args, {
    env: options.env,
    timeoutMs,
    timeoutLine: `crm.sh ${options.args[0] ?? ''} ran for more than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
    signal: options.signal,
    onStdout: onLine,
    onStderr: onLine,
  }).then((code) => ({ code, lines }));
}

const ACCEPTED_LINE = /^\[crm\] TWENTY_KEY_(?:RW|RO): Twenty accepts it$/;

function hideKeys(line: string, keys: string[]): string {
  let out = line;
  for (const key of keys) if (key) out = out.split(key).join('[key]');
  return out;
}

function errorMessage(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(ERROR_PREFIX)) return lines[i].slice(ERROR_PREFIX.length);
  }
  return null;
}

/**
 * Adds a hosted Twenty workspace with `crm.sh add`. The keys travel in the environment (both
 * variables are always set, so the script never prompts) and are masked in every returned line.
 */
export async function connectTwentyWorkspace(
  runScript: StackCommands['runScript'],
  baseEnv: NodeJS.ProcessEnv,
  input: TwentyConnectInput,
  run: typeof runCrmScript = runCrmScript
): Promise<TwentyConnectResult> {
  const args = ['add', '--slug', input.slug, '--url', input.url];
  if (input.replace) args.push('--force');
  const env = {
    ...baseEnv,
    TWENTY_KEY_RW: input.keyRw,
    TWENTY_KEY_RO: input.keyRo,
    TWENTY_ACCESS: input.access,
  };
  const keys = [input.keyRw, input.keyRo];
  const { code, lines: raw } = await run({ runScript, args, env, timeoutMs: CONNECT_TIMEOUT_MS });
  const lines = raw.map((line) => hideKeys(line, keys));
  const checks = lines.filter((line) => ACCEPTED_LINE.test(line));
  if (code === 0) return { ok: true, checks };

  const message = errorMessage(lines) ?? lines.at(-1) ?? `crm.sh add exited with code ${code}`;
  const fail = (
    reason: Extract<TwentyConnectResult, { ok: false }>['reason'],
    extra: { key?: 'RW' | 'RO'; status?: number } = {}
  ): TwentyConnectResult => ({ ok: false, reason, message, checks, ...extra });

  if (message.startsWith('no answer from ')) return fail('no-answer');
  const rejected = /^Twenty rejects TWENTY_KEY_(RW|RO) \(HTTP (\d+)\)/.exec(message);
  if (rejected) return fail('rejected', { key: rejected[1] as 'RW' | 'RO', status: Number(rejected[2]) });
  const answered = /answered HTTP (\d+) for TWENTY_KEY_(RW|RO)/.exec(message);
  if (answered) return fail('failed', { key: answered[2] as 'RW' | 'RO', status: Number(answered[1]) });
  if (/ exists(?: \(.*\))?; pass --force/.test(message)) return fail('exists');
  // Stack after v0.3.13: the keys work, but ?mode=meta lacks get_tool_catalog, learn_tools or execute_tool.
  if (/\/mcp\?mode=meta lists \d+ tools but not /.test(message)) return fail('no-catalog');
  if (
    message.startsWith('--slug must') ||
    message.startsWith('--url must') ||
    message.startsWith('TWENTY_ACCESS') ||
    message.startsWith('set TWENTY_KEY_RW') ||
    message.startsWith('a read/write key is required') ||
    message.startsWith('the URL holds ') ||
    message.startsWith('a key holds ')
  ) {
    return fail('invalid');
  }
  return fail('failed');
}

/** Deletes a workspace file with `crm.sh remove`. Throws the script's last error line on failure. */
export async function disconnectTwentyWorkspace(
  runScript: StackCommands['runScript'],
  baseEnv: NodeJS.ProcessEnv,
  slug: string,
  run: typeof runCrmScript = runCrmScript
): Promise<void> {
  const { code, lines } = await run({ runScript, args: ['remove', '--slug', slug], env: baseEnv });
  if (code === 0) return;
  throw new Error(errorMessage(lines) ?? lines.at(-1) ?? `crm.sh remove exited with code ${code}`);
}
