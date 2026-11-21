import path from 'node:path';
import type { SshConnection } from './sshConnection';
import { remoteCommand, shellQuote, type SshExec } from './sshStackCommands';
import type { SftpOps } from './sshStackFiles';
import type { StackRelease } from './stackRelease';

const posix = path.posix;

/**
 * The stack's named volume for downloaded models, declared at the top level of its
 * `docker-compose.yml`, so `--skip-volume` accepts it on a host that never ran Ollama.
 */
const MODELS_VOLUME = 'ollama_data';

/** What a stack folder on the host holds, read the way the stack's `install.sh` reads it. */
export type InstalledStack =
  /** Missing or empty: `install.sh` makes a fresh install. */
  | { kind: 'none' }
  /** An install `install.sh` made, at `version` (`.stack-version`'s first line). */
  | { kind: 'release'; version: string }
  /** A git checkout, which `install.sh` refuses; it is upgraded with git. */
  | { kind: 'checkout' }
  /** Files without `.stack-version`, which `install.sh` refuses as not its own. */
  | { kind: 'other' };

/** One `{"phase":"setup",…}` line from `install.sh --json`. */
export interface StackInstallStep {
  step: string;
  status: 'running' | 'done';
}

/** Something an upgrade hook couldn't do for the user (`needs_user` in `upgrades/lib.sh`). */
export interface StackNeedsUser {
  id: string;
  message: string;
  /** The release whose upgrade hook asked. */
  version: string;
}

/** A behaviour change an upgrade hook reported, with nothing to do. */
export interface StackNotice {
  message: string;
  version: string;
}

/** `install.sh`'s `done` line. */
export interface StackInstallResult {
  version: string;
  /** Null for a fresh install. */
  previousVersion: string | null;
  fresh: boolean;
  /** The backup the upgrade made, on the host. Null for a fresh install or the same version again. */
  backup: string | null;
  /** Shown to the user after an upgrade: the stack can't finish these alone. */
  needsUser: StackNeedsUser[];
  notices: StackNotice[];
}

export type StackInstallErrorCode =
  /** `install.sh`'s own reasons (exit 2, 4 and 1). */
  | 'bad_input'
  | 'command_failed'
  | 'unsupported_host'
  | 'checksum_mismatch'
  | 'busy'
  | 'doctor_failed'
  /** The run folder couldn't be made, the files didn't upload, or the run didn't start. */
  | 'not_started'
  /** `install.sh` ended without its `done` or `error` line, such as when it was killed. */
  | 'no_result'
  | 'cancelled'
  | 'timed_out'
  /** Following the run failed, usually because the connection dropped. The run goes on. */
  | 'connection_lost';

const INSTALL_REASONS = new Set<StackInstallErrorCode>([
  'bad_input',
  'command_failed',
  'unsupported_host',
  'checksum_mismatch',
  'busy',
  'doctor_failed',
]);

export class StackInstallError extends Error {
  readonly code: StackInstallErrorCode;
  /** The `install.sh` step that failed, when it named one. */
  readonly step: string | null;
  /** The failing step's log, last lines first-to-last, or `install.sh`'s stderr. */
  readonly logTail: string[];
  /** True when an upgrade put the previous release back and started it. */
  readonly rolledBack: boolean;
  /** The upgrade's backup on the host; its data can be restored from there. */
  readonly backup: string | null;
  /** Where the run's files are on the host, when they were left there. */
  readonly runFolder: string | null;

  constructor(
    code: StackInstallErrorCode,
    message: string,
    details: Partial<Pick<StackInstallError, 'step' | 'logTail' | 'rolledBack' | 'backup' | 'runFolder'>> = {}
  ) {
    super(message);
    this.name = 'StackInstallError';
    this.code = code;
    this.step = details.step ?? null;
    this.logTail = details.logTail ?? [];
    this.rolledBack = details.rolledBack ?? false;
    this.backup = details.backup ?? null;
    this.runFolder = details.runFolder ?? null;
  }
}

function isSftpMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 2 || code === 'ENOENT';
}

async function readOrNull(sftp: SftpOps, file: string): Promise<string | null> {
  try {
    return (await sftp.readFile(file)).toString('utf8');
  } catch (error) {
    if (isSftpMissing(error)) return null;
    throw error;
  }
}

/**
 * Reads what `stackRoot` on the host holds over SFTP, in the order `install.sh` checks it: a
 * `.git` makes it a checkout, then `.stack-version`, then any other entry besides the installer's
 * own lock and temp folders. Needs no engine and no stack script, so it works on a host whose
 * stack is at another version than the pin, is stopped, or isn't there yet.
 */
export async function readInstalledStack(sftp: SftpOps, stackRoot: string): Promise<InstalledStack> {
  let entries: string[];
  try {
    entries = await sftp.readdir(stackRoot);
  } catch (error) {
    if (isSftpMissing(error)) return { kind: 'none' };
    throw error;
  }
  if (entries.includes('.git')) return { kind: 'checkout' };
  if (entries.includes('.stack-version')) {
    const text = (await readOrNull(sftp, posix.join(stackRoot, '.stack-version'))) ?? '';
    return { kind: 'release', version: text.split('\n')[0].replace(/\s/g, '') };
  }
  const own = (name: string) => name === '.install.lock' || name.startsWith('.install-tmp.');
  return entries.some((name) => !own(name)) ? { kind: 'other' } : { kind: 'none' };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

type InstallLine =
  | { phase: 'setup'; step: StackInstallStep }
  | { phase: 'done'; result: StackInstallResult }
  | { phase: 'error'; code: StackInstallErrorCode; message: string; step: string | null; logTail: string[]; rolledBack: boolean; backup: string | null };

/** One line of `install.sh --json` at v0.3.16, or null for anything else. */
export function parseInstallLine(line: string): InstallLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.phase === 'setup' && typeof raw.step === 'string' && (raw.status === 'running' || raw.status === 'done')) {
    return { phase: 'setup', step: { step: raw.step, status: raw.status } };
  }
  if (raw.phase === 'done' && typeof raw.version === 'string') {
    const needsUser = Array.isArray(raw.needs_user) ? raw.needs_user.filter(isRecord) : [];
    const notices = Array.isArray(raw.notices) ? raw.notices.filter(isRecord) : [];
    return {
      phase: 'done',
      result: {
        version: raw.version,
        previousVersion: str(raw.previous_version),
        fresh: raw.fresh === true,
        backup: str(raw.backup),
        needsUser: needsUser.map((n) => ({ id: str(n.id) ?? '', message: str(n.message) ?? '', version: str(n.version) ?? '' })),
        notices: notices.map((n) => ({ message: str(n.message) ?? '', version: str(n.version) ?? '' })),
      },
    };
  }
  if (raw.phase === 'error') {
    const reason = str(raw.error) as StackInstallErrorCode | null;
    return {
      phase: 'error',
      code: reason && INSTALL_REASONS.has(reason) ? reason : 'command_failed',
      message: str(raw.message) ?? 'The agent stack install failed.',
      step: str(raw.step),
      logTail: strings(raw.logTail),
      rolledBack: raw.rolledBack === true,
      backup: str(raw.backup),
    };
  }
  return null;
}

/** Runs a short command on the host, keeping its output. */
async function runOnHost(exec: SshExec, command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const { exitCode } = await exec(command, { onStdout: (c) => out.push(c), onStderr: (c) => err.push(c) });
  return { code: exitCode, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

const lastLine = (text: string) => text.trim().split('\n').at(-1) ?? '';

/**
 * Starts `"$@"` in the run folder so it outlives the SSH connection: `nohup` with no terminal and
 * every stream on a file, so a dropped connection neither hangs it up nor breaks its output.
 * stdout goes to `install.log`, stderr to `install.err`, its pid to `install.pid`, and its exit
 * status to `install.exit`, written last through a rename so it is never read half written.
 */
export const DETACHED_LAUNCHER =
  'command -v nohup > /dev/null 2>&1 || { echo "nohup is not installed" >&2; exit 127; }\n' +
  `nohup sh -c '"$@" > install.log 2> install.err & echo $! > install.pid; wait $!; ` +
  `echo $? > install.exit.tmp && mv install.exit.tmp install.exit' sh "$@" > /dev/null 2>&1 < /dev/null &\n`;

const RUN_FOLDER_COMMAND = `exec sh -c ${shellQuote('mktemp -d "${TMPDIR:-/tmp}/boundary-stack-install.XXXXXX"')}`;

export interface StackInstallDeps {
  connection: Pick<SshConnection, 'exec' | 'sftp'>;
  /** The stack's folder on the host, absolute. It may not exist yet. */
  stackRoot: string;
  /** How the host is named in errors, such as `user@pc.local`. */
  hostLabel: string;
  /** The checked release (`fetchStackRelease`). */
  release: StackRelease;
  /** Leave downloaded models out of the backup an upgrade makes (`--skip-volume ollama_data`, CR 0037 R5). */
  leaveOutModels?: boolean;
  /** Passed to `setup.sh --non-interactive` after `--`, such as `--db` or `--research`. */
  setupArgs?: string[];
  onStep?: (step: StackInstallStep) => void;
  /**
   * Stops `install.sh` with TERM. Only the script itself is stopped, and an upgrade cut off after
   * its backup isn't rolled back, so this is for a run that has stopped making progress.
   */
  signal?: AbortSignal;
  /** How long the whole run may take: image pulls, the backup and the start. 4 hours by default. */
  timeoutMs?: number;
  /** How often the run's output is read. 2 seconds by default. */
  pollMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60 * 60_000;
const DEFAULT_POLL_MS = 2_000;

/**
 * Installs the stack on a host reached over SSH, or upgrades the install there (remote stack
 * plan, step 4c; CR 0037 R1). Uploads the checked release tarball and its `install.sh` over SFTP
 * into a fresh run folder on the host, starts `install.sh --tarball … --sha256 … --json` there
 * detached from the connection, and follows its output until it ends. `install.sh` checks the
 * checksum again on the host, refuses a downgrade, a checkout and a folder it didn't make, backs
 * up before an upgrade (the backup stays on the host) and rolls the files back when a later step
 * fails.
 *
 * Resolves with the `done` line; its `needsUser` entries are for the user. Rejects with
 * {@link StackInstallError}. The run folder is removed once `install.sh` has ended, and left on
 * the host otherwise, named in the error.
 */
export async function installStackOverSsh(deps: StackInstallDeps): Promise<StackInstallResult> {
  const { connection, stackRoot, hostLabel, release } = deps;
  const { exec, sftp } = connection;
  if (!posix.isAbsolute(stackRoot)) {
    throw new StackInstallError('bad_input', `The stack folder on ${hostLabel} must be an absolute path: ${stackRoot}`);
  }
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  type HostRun = Awaited<ReturnType<typeof runOnHost>>;
  const made = await runOnHost(exec, RUN_FOLDER_COMMAND).catch((error: unknown): HostRun => ({
    code: null,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
  }));
  const runFolder = made.stdout.trim();
  if (made.code !== 0 || !posix.isAbsolute(runFolder)) {
    throw new StackInstallError('not_started', `Couldn’t make a folder for the install on ${hostLabel}: ${lastLine(made.stderr) || 'mktemp failed'}`);
  }
  const inRun = (name: string) => posix.join(runFolder, name);
  const removeRunFolder = (): Promise<void> =>
    runOnHost(exec, remoteCommand('/', ['rm', '-rf', runFolder])).then(
      (): void => undefined,
      (): void => undefined
    );

  const tarball = inRun(`${release.name}.tar.gz`);
  const args = [
    '--version',
    release.version,
    '--dir',
    stackRoot,
    '--tarball',
    tarball,
    '--sha256',
    release.sha256,
    '--json',
    ...(deps.leaveOutModels ? ['--skip-volume', MODELS_VOLUME] : []),
    ...(deps.setupArgs?.length ? ['--', ...deps.setupArgs] : []),
  ];
  try {
    await sftp.writeFile(tarball, release.tarball, 0o600);
    await sftp.writeFile(inRun('install.sh'), release.installScript, 0o600);
    const launched = await runOnHost(exec, remoteCommand(runFolder, ['sh', '-c', DETACHED_LAUNCHER, 'sh', 'bash', 'install.sh', ...args]));
    if (launched.code !== 0) throw new Error(lastLine(launched.stderr) || `exited with ${launched.code}`);
  } catch (error) {
    await removeRunFolder();
    const message = error instanceof Error ? error.message : String(error);
    throw new StackInstallError('not_started', `Couldn’t start the agent stack install on ${hostLabel}: ${message}`);
  }

  let seen = 0;
  let outcome: InstallLine | null = null;
  const take = (log: string, ended: boolean) => {
    const lines = log.split('\n');
    const complete = ended ? lines : lines.slice(0, -1);
    for (const line of complete.slice(seen)) {
      const parsed = parseInstallLine(line.trim());
      if (parsed?.phase === 'setup') deps.onStep?.(parsed.step);
      else if (parsed) outcome = parsed;
    }
    seen = Math.max(seen, complete.length);
  };

  const stop = () => runOnHost(exec, remoteCommand(runFolder, ['sh', '-c', 'kill -TERM "$(cat install.pid)"'])).catch((): null => null);
  const started = Date.now();
  let exitText: string | null;
  let stopped: 'cancelled' | 'timed_out' | null = null;
  try {
    for (;;) {
      exitText = await readOrNull(sftp, inRun('install.exit'));
      take((await readOrNull(sftp, inRun('install.log'))) ?? '', exitText !== null);
      if (exitText !== null) break;
      if (deps.signal?.aborted) stopped = 'cancelled';
      else if (Date.now() - started >= timeoutMs) stopped = 'timed_out';
      if (stopped) {
        await stop();
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done() {
          clearTimeout(timer);
          deps.signal?.removeEventListener('abort', done);
          resolve();
        }
        deps.signal?.addEventListener('abort', done, { once: true });
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StackInstallError(
      'connection_lost',
      `Lost track of the agent stack install on ${hostLabel} (${message}). It goes on there; its output is in ${inRun('install.log')}.`,
      { runFolder }
    );
  }

  if (stopped) {
    throw new StackInstallError(
      stopped,
      stopped === 'cancelled'
        ? `Stopped the agent stack install on ${hostLabel}. Its output is in ${inRun('install.log')}.`
        : `The agent stack install on ${hostLabel} took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped. Its output is in ${inRun('install.log')}.`,
      { runFolder }
    );
  }

  const result = outcome as InstallLine | null;
  if (result?.phase === 'done') {
    await removeRunFolder();
    return result.result;
  }
  if (result?.phase === 'error') {
    await removeRunFolder();
    throw new StackInstallError(result.code, result.message, result);
  }
  const stderr = ((await readOrNull(sftp, inRun('install.err')).catch((): null => null)) ?? '').trim();
  await removeRunFolder();
  throw new StackInstallError(
    'no_result',
    `The agent stack install on ${hostLabel} exited with ${exitText?.trim() || 'no status'} without a result${stderr ? `: ${lastLine(stderr)}` : ''}`,
    { logTail: stderr ? stderr.split('\n').slice(-20) : [] }
  );
}
