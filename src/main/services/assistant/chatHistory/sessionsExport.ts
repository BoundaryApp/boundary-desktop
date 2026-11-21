import { outcomeText, runAddonScript } from '../../addons/addonScript';
import { SCRIPT_CANCELLED } from '../../stackHost/localScript';
import type { StackCommands } from '../../stackHost/types';

// `scripts/sessions.sh export --dest DIR --json` (CR 0039 R1, stack v0.3.16), as checked in the
// script and `scripts/lib/sessions_move.py` at the tag. One line per profile:
//
//   {"phase":"profile","profile":P,"sessions":N,"messages":M}
//
// then `{"phase":"done","action":"export","dest":DIR,"sessions":N,"messages":M}`, or an error line
// with `bad_input` (exit 2: DEST isn't new or empty), `hermes_not_running` (exit 1) or
// `command_failed` (exit 4). Lines carry counts and profile names only. DIR gets one
// `<profile>.jsonl` per profile and `manifest.json`; Boundary never opens the `.jsonl` files.

export interface SessionsProfileLine {
  profile: string;
  sessions: number;
  messages: number;
}

export type SessionsExportOutcome =
  | { kind: 'done'; dest: string; sessions: number; messages: number; profiles: SessionsProfileLine[] }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string; message: string };

/** An export of every profile can take a while on a long history; this is only a backstop. */
const EXPORT_TIMEOUT_MS = 30 * 60_000;

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

/** A `profile` line of the export, or null for any other line. */
export function parseExportProfileLine(line: { phase: string } & Record<string, unknown>): SessionsProfileLine | null {
  if (line.phase !== 'profile' || typeof line.profile !== 'string' || !line.profile) return null;
  return { profile: line.profile, sessions: count(line.sessions), messages: count(line.messages) };
}

export interface SessionsExportRun {
  commands: Pick<StackCommands, 'runScript' | 'scriptEnv'>;
  /** An absolute folder on the stack host that is new or empty. */
  dest: string;
  onProfile?: (line: SessionsProfileLine) => void;
  signal?: AbortSignal;
  /** Added to the script's environment; the `test:stack` case points `SESSIONS_PY` at a throwaway container. */
  env?: NodeJS.ProcessEnv;
}

/** Runs the export and reads its lines. Never rejects for a script failure; the outcome names it. */
export async function runSessionsExport(run: SessionsExportRun): Promise<SessionsExportOutcome> {
  const env = { ...(await run.commands.scriptEnv([])), ...run.env };
  const profiles: SessionsProfileLine[] = [];
  const outcome = await runAddonScript({
    runScript: run.commands.runScript,
    script: 'sessions.sh',
    args: ['export', '--dest', run.dest, '--json'],
    env,
    timeoutMs: EXPORT_TIMEOUT_MS,
    signal: run.signal,
    onLine: (line) => {
      const parsed = parseExportProfileLine(line);
      if (!parsed) return;
      profiles.push(parsed);
      run.onProfile?.(parsed);
    },
  });
  if (outcome.kind === 'done') {
    const { done } = outcome;
    if (done.action !== 'export') {
      return { kind: 'failed', error: 'command_failed', message: 'sessions.sh ended with a result that isn’t an export' };
    }
    return {
      kind: 'done',
      dest: typeof done.dest === 'string' ? done.dest : run.dest,
      sessions: count(done.sessions),
      messages: count(done.messages),
      profiles,
    };
  }
  if (outcome.kind === 'exited' && (outcome.code === SCRIPT_CANCELLED || run.signal?.aborted)) return { kind: 'cancelled' };
  if (outcome.kind === 'error') return { kind: 'failed', error: outcome.error, message: outcome.message };
  return { kind: 'failed', error: 'command_failed', message: outcomeText(outcome) };
}
