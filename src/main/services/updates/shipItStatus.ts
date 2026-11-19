import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What Squirrel.Mac's installer did last, read from the launchd job it submits and the log it
 * writes. An install that fails is retried by launchd and relaunches the app when it succeeds,
 * so a looping install shows up here rather than in Boundary's own log.
 *
 * Squirrel names both after the bundle ID: the job is `<id>.ShipIt`, and its log is
 * `~/Library/Caches/<id>.ShipIt/ShipIt_stderr.log`. The folder and `ShipItState.plist` stay
 * after a successful install, so neither one means an install is pending.
 */
export type ShipItOutcome = 'installed' | 'error' | 'gave-up' | 'app-running' | 'update-missing' | 'started';

export interface ShipItJob {
  state: string;
  runs: number | null;
  lastExit: number | null;
}

export interface ShipItLogSummary {
  outcome: ShipItOutcome | null;
  /** The highest retry ShipIt reached since its last finished install. */
  attempts: number;
  /** The line that set a failed outcome, with the home folder shortened. */
  detail: string | null;
}

export interface ShipItStatus extends ShipItLogSummary {
  job: ShipItJob | null;
  logUpdatedAt: string | null;
}

/** Enough for several install attempts; older lines don't change the outcome. */
const LOG_TAIL_BYTES = 64 * 1024;
const DETAIL_MAX = 300;

// Messages from ShipIt's own source, matched after the timestamp and process prefix.
const OUTCOMES: [RegExp, ShipItOutcome, boolean][] = [
  [/^Installation completed successfully/, 'installed', false],
  [/^Too many attempts to install/, 'gave-up', true],
  [/^Aborting update attempt because there are \d+ running instances/, 'app-running', true],
  [/^Update bundle .* no longer exists/, 'update-missing', true],
  [/^(Installation error:|Error aborting installation:|Could not restore bundle|Privileged install rejected:)/, 'error', true],
  [/^Beginning installation/, 'started', false],
];
const ATTEMPT = /^Resuming installation attempt (\d+)/;
const PREFIX = /^\d{4}-\d\d-\d\d [\d:.]+ ShipIt\[\d+:\d+\] /;

export function parseShipItLog(text: string, home: string): ShipItLogSummary {
  const summary: ShipItLogSummary = { outcome: null, attempts: 0, detail: null };
  for (const raw of text.split('\n')) {
    if (!PREFIX.test(raw)) continue;
    const message = raw.replace(PREFIX, '').trim();
    const attempt = ATTEMPT.exec(message);
    if (attempt) {
      summary.attempts = Math.max(summary.attempts, Number(attempt[1]));
      continue;
    }
    const match = OUTCOMES.find(([pattern]) => pattern.test(message));
    if (!match) continue;
    const [, outcome, failed] = match;
    summary.outcome = outcome;
    summary.detail = failed ? message.split(home).join('~').slice(0, DETAIL_MAX) : null;
    if (outcome === 'installed') summary.attempts = 0;
  }
  return summary;
}

/** Reads `launchctl print`'s top-level fields; nested blocks are indented further. */
export function parseLaunchdJob(text: string): ShipItJob | null {
  const field = (name: string) => new RegExp(`^\\t?${name} = (.+)$`, 'm').exec(text)?.[1]?.trim();
  const state = field('state');
  if (!state) return null;
  const number = (value: string | undefined) => (value && /^-?\d+$/.test(value) ? Number(value) : null);
  return { state, runs: number(field('runs')), lastExit: number(field('last exit code')) };
}

async function readTail(path: string): Promise<{ text: string; modified: Date } | null> {
  let file;
  try {
    file = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const { size, mtime } = await file.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return { text: buffer.toString('utf8'), modified: mtime };
  } finally {
    await file.close();
  }
}

export interface ShipItStatusDeps {
  bundleId: string;
  /** `~/Library/Caches`. */
  caches: string;
  home: string;
  /** `launchctl print` output for a job in this user's domain; throws when there is no job. */
  printJob: (label: string) => Promise<string>;
}

/** Null when ShipIt has never run for this bundle ID. */
export async function readShipItStatus(deps: ShipItStatusDeps): Promise<ShipItStatus | null> {
  const label = `${deps.bundleId}.ShipIt`;
  const dir = join(deps.caches, label);
  try {
    await stat(dir);
  } catch {
    return null;
  }
  const [job, log] = await Promise.all([
    deps.printJob(label).then(parseLaunchdJob, (): ShipItJob | null => null),
    readTail(join(dir, 'ShipIt_stderr.log')),
  ]);
  const summary = log ? parseShipItLog(log.text, deps.home) : { outcome: null, attempts: 0, detail: null };
  return { job, logUpdatedAt: log ? log.modified.toISOString() : null, ...summary };
}
