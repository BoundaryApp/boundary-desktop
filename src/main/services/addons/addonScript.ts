import type { ActualScriptFailure } from '../../../shared/types/addons';
import { SCRIPT_CANCELLED, SCRIPT_NOT_STARTED, SCRIPT_TIMED_OUT } from '../stackHost/localScript';
import type { StackCommands, StackFiles } from '../stackHost/types';
import { isRecord } from '../../../shared/utils/isRecord';

// Runs the stack's JSON-line scripts, `scripts/addon.sh`, `budget.sh`, `vault.sh` and `sessions.sh`, in JSON mode and
// reads their JSON lines (CR 0026 round 4, CR 0020's addon.sh reply). Every line keys on `phase`;
// the last is one `done` or `error`, and nothing follows it. Errors are named, so callers key on
// `error`, never on the exit code. Credentials travel only on stdin, as one JSON object.
//
// Every add-on installer runs its scripts through this module.

export type AddonScript = 'addon.sh' | 'budget.sh' | 'vault.sh' | 'web-browser-secrets.sh' | 'env.sh' | 'sessions.sh';

/** A `pull`, `setup`, `budget` or other non-final line. */
export type AddonScriptLine = { phase: string } & Record<string, unknown>;

export type AddonScriptOutcome =
  | { kind: 'done'; done: Record<string, unknown>; lines: AddonScriptLine[] }
  | {
      kind: 'error';
      error: string;
      message: string;
      step: string | null;
      logTail: string[];
      lines: AddonScriptLine[];
      /** `rate_limited`'s wait in whole seconds, when the stack knows it (CR 0028 R1). */
      retryAfter?: number;
    }
  /**
   * The script ended without a `done` or `error` line: it crashed, couldn't start (127), ran
   * past the timeout (124) or was cancelled (130). `logTail` is its last stderr lines.
   */
  | { kind: 'exited'; code: number; logTail: string[]; lines: AddonScriptLine[] };

export interface AddonScriptRun {
  /** The stack host's `runScript`, which runs the script from the stack folder. */
  runScript: StackCommands['runScript'];
  script: AddonScript;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** One JSON object written to stdin, then stdin closes. Without it stdin is closed at once. */
  input?: Record<string, unknown>;
  /** Each non-final line as it arrives. */
  onLine?: (line: AddonScriptLine) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const LOG_TAIL_LINES = 20;
export const ADDON_SCRIPT_TIMED_OUT = SCRIPT_TIMED_OUT;

/** The string values of `input`, which never appear in a kept line. */
function secretsOf(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v !== 'string' || v.length < 4) continue;
    out.push(v);
    // A script that echoes its stdin JSON prints the escaped form.
    const escaped = JSON.stringify(v).slice(1, -1);
    if (escaped !== v) out.push(escaped);
  }
  return out;
}

/**
 * Starts `bash scripts/<script> <args>` in the stack folder with `input` on stdin. Stderr lines are
 * redacted and the last 20 kept; `stderrTail()` reads them once the run has ended.
 */
function startScript(
  run: Omit<AddonScriptRun, 'onLine'>,
  secrets: string[],
  onStdout: (line: string) => void
): { exit: Promise<number>; stderrTail: () => string[] } {
  const timeoutMs = run.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stderr: string[] = [];
  const exit = run.runScript(`scripts/${run.script}`, run.args, {
    env: run.env,
    input: run.input ? JSON.stringify(run.input) : '',
    timeoutMs,
    timeoutLine: `${run.script} ${run.args[0] ?? ''} ran for more than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
    signal: run.signal,
    onStdout,
    onStderr: (line) => {
      stderr.push(redact(line, secrets));
      if (stderr.length > LOG_TAIL_LINES) stderr = stderr.slice(-LOG_TAIL_LINES);
    },
  });
  return { exit, stderrTail: () => stderr };
}

/**
 * Replaces each secret in `text` with `[redacted]`. The scripts never print one (CR 0026 R1),
 * so this guards Boundary's logs and renderer against a script that does.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

function parseLine(line: string): AddonScriptLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (isRecord(value) && typeof value.phase === 'string') {
      return value as AddonScriptLine;
    }
  } catch {
    /* not a JSON line */
  }
  return null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Runs `bash scripts/<script> <args>` in the stack folder. Only the input's keys and the slug reach the
 * script; argv carries no credential. Values from `input` are redacted in every kept line.
 */
export function runAddonScript(run: AddonScriptRun): Promise<AddonScriptOutcome> {
  const secrets = secretsOf(run.input);
  const lines: AddonScriptLine[] = [];
  let final: AddonScriptLine | null = null;
  const onStdout = (raw: string) => {
    const parsed = parseLine(redact(raw, secrets));
    if (!parsed || final) return;
    if (parsed.phase === 'done' || parsed.phase === 'error') {
      final = parsed;
      return;
    }
    lines.push(parsed);
    run.onLine?.(parsed);
  };

  const { exit, stderrTail } = startScript(run, secrets, onStdout);
  return exit.then((code): AddonScriptOutcome => {
    const stderr = stderrTail();
    const done = final as AddonScriptLine | null;
    if (done?.phase === 'done') return { kind: 'done', done, lines };
    if (done?.phase === 'error') {
      const tail = Array.isArray(done.logTail) ? done.logTail.filter((l): l is string => typeof l === 'string') : [];
      return {
        kind: 'error',
        error: text(done.error) || 'command_failed',
        message: text(done.message),
        step: typeof done.step === 'string' ? done.step : null,
        logTail: tail.length ? tail : stderr,
        lines,
        ...(typeof done.retryAfter === 'number' && Number.isFinite(done.retryAfter) && done.retryAfter > 0
          ? { retryAfter: Math.round(done.retryAfter) }
          : {}),
      };
    }
    return { kind: 'exited', code, logTail: stderr, lines };
  });
}

/**
 * Sums `addon.sh`'s `pull` lines (`service`, `current`, `total`) over services. The returned
 * function gives the running totals for a pull line that carries byte counts, else null.
 */
export function pullByteTotals(): (line: AddonScriptLine) => { done: number; total: number } | null {
  const bytes = new Map<string, { current: number; total: number }>();
  return (line) => {
    if (line.phase !== 'pull' || typeof line.current !== 'number' || typeof line.total !== 'number') return null;
    bytes.set(typeof line.service === 'string' ? line.service : '', { current: line.current, total: line.total });
    let done = 0;
    let total = 0;
    for (const b of bytes.values()) {
      done += b.current;
      total += b.total;
    }
    return { done, total };
  };
}

/** One line for a log or the UI: the error's name and message, or how the script ended. */
export function outcomeText(outcome: AddonScriptOutcome): string {
  if (outcome.kind === 'done') return 'done';
  if (outcome.kind === 'error') return outcome.message ? `${outcome.error}: ${outcome.message}` : outcome.error;
  if (outcome.code === ADDON_SCRIPT_TIMED_OUT) return 'the script ran past its time limit';
  if (outcome.code === SCRIPT_NOT_STARTED) return 'bash couldn’t start the script';
  if (outcome.code === SCRIPT_CANCELLED) return 'cancelled';
  const last = outcome.logTail.at(-1);
  return `the script exited with code ${outcome.code} and no result${last ? `: ${last}` : ''}`;
}

/** What `vault.sh status`, `sync` and `requests` print: plain JSON objects, not `phase` lines. */
export interface ScriptJsonOutcome {
  /** The exit code; 124 for a timeout, 127 when bash couldn't start, 130 when cancelled. */
  code: number;
  /** Each stdout line that parsed as a JSON object, in order. */
  objects: Record<string, unknown>[];
  logTail: string[];
}

/**
 * Runs `bash scripts/<script> <args>` in the stack folder and collects every JSON object line on stdout,
 * for the `vault.sh` commands whose output is the broker's reply rather than event lines
 * (CR 0028 R2, R4, R5). Stdin is closed at once; these commands take no input.
 */
export function runScriptJson(run: Omit<AddonScriptRun, 'input' | 'onLine'>): Promise<ScriptJsonOutcome> {
  const objects: Record<string, unknown>[] = [];
  const { exit, stderrTail } = startScript({ ...run, input: undefined }, [], (raw) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isRecord(value)) objects.push(value);
    } catch {
      /* not a JSON line */
    }
  });
  return exit.then((code) => ({ code, objects, logTail: stderrTail() }));
}

/** What `addon.sh configure` and `addon.sh run` leave: an exit code, stdout whole and the stderr tail. */
export interface PlainOutcome {
  /** The exit code; 124 for a timeout, 127 when bash couldn't start, 130 when cancelled. */
  code: number;
  /** All of stdout, with every string value of the input redacted. */
  stdout: string;
  /** The last 20 stderr lines, redacted. */
  stderrTail: string[];
}

/**
 * Runs `bash scripts/<script> <args>` in the stack folder for commands that print no phase lines:
 * `configure` prints nothing and `run` prints one indented JSON array. The caller parses stdout.
 */
export function runAddonScriptPlain(run: Omit<AddonScriptRun, 'onLine'>): Promise<PlainOutcome> {
  const secrets = secretsOf(run.input);
  const out: string[] = [];
  const { exit, stderrTail } = startScript(run, secrets, (line) => out.push(line));
  return exit.then((code) => ({ code, stdout: redact(out.join('\n'), secrets), stderrTail: stderrTail() }));
}

/** A run that didn't end with `done`, as the named failure callers return to the renderer. */
export function scriptFailure(outcome: AddonScriptOutcome): ActualScriptFailure {
  return outcome.kind === 'error'
    ? { ok: false, error: outcome.error, message: outcome.message }
    : { ok: false, error: 'command_failed', message: outcomeText(outcome) };
}

/** A file in the stack's folder as text, or null when it is missing or can't be read. */
export async function readStackFile(files: StackFiles, relPath: string): Promise<string | null> {
  try {
    return await files.readText('stack', relPath);
  } catch {
    return null;
  }
}

/** Whether a dotenv value turns a flag on. */
export const flagOn = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? '').trim());

/** `addon.sh enable <id> --json`, logging its outcome (the error's name only). */
export async function enableAddon(
  deps: {
    run(script: 'addon.sh', args: string[], options?: { onLine?: (l: AddonScriptLine) => void; timeoutMs?: number }): Promise<AddonScriptOutcome>;
    log(message: string, data: Record<string, unknown>): void;
  },
  id: string,
  options: { onLine?: (l: AddonScriptLine) => void; timeoutMs: number }
): Promise<AddonScriptOutcome> {
  const outcome = await deps.run('addon.sh', ['enable', id, '--json'], options);
  deps.log('enable', { outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
  return outcome;
}

/** The entry of `addon.sh list --json` whose `shortId` is `shortId`, or null when the output has none. */
export function findListEntry(stdout: string, shortId: string): Record<string, unknown> | null {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const entry: unknown = list.find((e) => isRecord(e) && e.shortId === shortId);
  return isRecord(entry) ? entry : null;
}
