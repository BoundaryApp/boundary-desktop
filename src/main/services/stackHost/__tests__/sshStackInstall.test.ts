import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteCommand, type SshExec } from '../sshStackCommands';
import type { SftpOps } from '../sshStackFiles';
import {
  DETACHED_LAUNCHER,
  installStackOverSsh,
  parseInstallLine,
  readInstalledStack,
  StackInstallError,
  type StackInstallDeps,
} from '../sshStackInstall';
import type { StackRelease } from '../stackRelease';
import { sftpOverLocalFiles, shExec } from './sshTestDoubles';

// The lines `scripts/install.sh --json` prints at v0.3.16, in its own field order. `needs_user`
// and `notices` are what `scripts/upgrade.sh` collects from the hooks' directives
// (`upgrades/lib.sh`); the ids are v0.3.16's own hooks'.
const LINES = {
  check: '{"phase":"setup","step":"check","status":"done"}',
  verify: '{"phase":"setup","step":"verify","status":"done"}',
  stopRunning: '{"phase":"setup","step":"stop","status":"running"}',
  stopDone: '{"phase":"setup","step":"stop","status":"done"}',
  upgraded:
    '{"phase":"done","version":"v0.3.16","previous_version":"v0.3.15","fresh":false,"backup":"/srv/stack/backups/20261119-120000",' +
    '"needs_user":[{"id":"bitwarden-in-page-fill","message":"Sign in to Bitwarden again.","version":"v0.3.16"}],' +
    '"notices":[{"message":"Cron jobs need enabled_toolsets.","version":"v0.3.16"}],"doctor":"passed"}',
  fresh: '{"phase":"done","version":"v0.3.16","previous_version":null,"fresh":true,"backup":null,"needs_user":[],"notices":[],"doctor":"passed"}',
  refused:
    '{"phase":"error","error":"bad_input","step":"backup","message":"the backup refused its input; v0.3.15 was started again and nothing else was changed",' +
    '"logTail":["{\\"phase\\":\\"error\\",\\"error\\":\\"bad_input\\"}"],"rolledBack":false,"backup":null}',
};

describe('parseInstallLine', () => {
  it("reads install.sh's setup, done and error lines and nothing else", () => {
    expect(parseInstallLine(LINES.stopRunning)).toEqual({ phase: 'setup', step: { step: 'stop', status: 'running' } });
    expect(parseInstallLine(LINES.upgraded)).toEqual({
      phase: 'done',
      result: {
        version: 'v0.3.16',
        previousVersion: 'v0.3.15',
        fresh: false,
        backup: '/srv/stack/backups/20261119-120000',
        needsUser: [{ id: 'bitwarden-in-page-fill', message: 'Sign in to Bitwarden again.', version: 'v0.3.16' }],
        notices: [{ message: 'Cron jobs need enabled_toolsets.', version: 'v0.3.16' }],
      },
    });
    expect(parseInstallLine(LINES.refused)).toMatchObject({ phase: 'error', code: 'bad_input', step: 'backup', rolledBack: false });
    expect(parseInstallLine('{"phase":"error","error":"something_new","message":"m"}')).toMatchObject({ code: 'command_failed' });
    expect(parseInstallLine('== setup')).toBeNull();
    expect(parseInstallLine('{"phase":"done"}')).toBeNull();
  });
});

describe('readInstalledStack', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-stack-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the folder as install.sh does: checkout, release, its own leftovers, or not its own', async () => {
    const sftp = sftpOverLocalFiles();
    const stack = path.join(root, 'stack');
    expect(await readInstalledStack(sftp, stack)).toEqual({ kind: 'none' });
    fs.mkdirSync(path.join(stack, '.install-tmp.abc123'), { recursive: true });
    fs.mkdirSync(path.join(stack, '.install.lock'));
    expect(await readInstalledStack(sftp, stack)).toEqual({ kind: 'none' });
    fs.writeFileSync(path.join(stack, 'notes.txt'), 'x');
    expect(await readInstalledStack(sftp, stack)).toEqual({ kind: 'other' });
    fs.writeFileSync(path.join(stack, '.stack-version'), ' v0.3.15 \nextra\n');
    expect(await readInstalledStack(sftp, stack)).toEqual({ kind: 'release', version: 'v0.3.15' });
    fs.mkdirSync(path.join(stack, '.git'));
    expect(await readInstalledStack(sftp, stack)).toEqual({ kind: 'checkout' });
  });
});

describe('DETACHED_LAUNCHER', () => {
  let run: string;
  beforeEach(() => {
    run = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-')));
  });
  afterEach(() => fs.rmSync(run, { recursive: true, force: true }));

  const runIn = async (exec: SshExec, argv: string[]) => {
    const err: Buffer[] = [];
    const { exitCode } = await exec(remoteCommand(run, argv), { onStdout: () => undefined, onStderr: (c) => err.push(c) });
    return { exitCode, stderr: Buffer.concat(err).toString() };
  };
  // Waits on the condition, not on time.
  const untilExited = (exec: SshExec) => runIn(exec, ['sh', '-c', 'while [ ! -f install.exit ]; do sleep 0.05; done']);

  it('returns at once and leaves the command running, with its output, pid and status in files', async () => {
    const { exec } = shExec();
    fs.writeFileSync(
      path.join(run, 'install.sh'),
      'while [ ! -f go ]; do sleep 0.05; done\nread -r l || echo "stdin closed"\nprintf "%s|" "$@"; echo\necho oops >&2\nexit 3\n'
    );
    expect(await runIn(exec, ['sh', '-c', DETACHED_LAUNCHER, 'sh', 'bash', 'install.sh', "a b'c", '--json'])).toEqual({
      exitCode: 0,
      stderr: '',
    });
    expect(fs.existsSync(path.join(run, 'install.exit'))).toBe(false);
    fs.writeFileSync(path.join(run, 'go'), '');
    await untilExited(exec);
    expect(fs.readFileSync(path.join(run, 'install.log'), 'utf8')).toBe("stdin closed\na b'c|--json|\n");
    expect(fs.readFileSync(path.join(run, 'install.err'), 'utf8')).toBe('oops\n');
    expect(fs.readFileSync(path.join(run, 'install.exit'), 'utf8')).toBe('3\n');
    expect(fs.readFileSync(path.join(run, 'install.pid'), 'utf8')).toMatch(/^\d+\n$/);
    expect(fs.existsSync(path.join(run, 'install.exit.tmp'))).toBe(false);
  });

  it('records the status of a run stopped with TERM, and of a script that is missing', async () => {
    const { exec } = shExec();
    fs.writeFileSync(path.join(run, 'install.sh'), 'touch started\nwhile :; do sleep 0.05; done\n');
    await runIn(exec, ['sh', '-c', DETACHED_LAUNCHER, 'sh', 'bash', 'install.sh']);
    await runIn(exec, ['sh', '-c', 'while [ ! -f started ]; do sleep 0.05; done']);
    await runIn(exec, ['sh', '-c', 'kill -TERM "$(cat install.pid)"']);
    await untilExited(exec);
    expect(fs.readFileSync(path.join(run, 'install.exit'), 'utf8')).toBe('143\n');

    fs.rmSync(path.join(run, 'install.exit'));
    await runIn(exec, ['sh', '-c', DETACHED_LAUNCHER, 'sh', 'bash', 'nosuch.sh']);
    await untilExited(exec);
    expect(fs.readFileSync(path.join(run, 'install.exit'), 'utf8')).toBe('127\n');
    expect(fs.readFileSync(path.join(run, 'install.err'), 'utf8')).toMatch(/nosuch\.sh/);
  });
});

/** SFTP over an in-memory file map, so polling runs on fake timers alone. */
function memorySftp(files: Map<string, Buffer>, modes: Map<string, number>): SftpOps {
  const missing = (file: string) => Object.assign(new Error(`No such file: ${file}`), { code: 2 });
  const unused = () => Promise.reject(new Error('not used by the installer'));
  return {
    readFile: async (file) => {
      const data = files.get(file);
      if (!data) throw missing(file);
      return data;
    },
    writeFile: async (file, data, mode) => {
      files.set(file, data);
      if (mode !== undefined) modes.set(file, mode);
    },
    stat: unused,
    lstat: unused,
    realpath: unused,
    readdir: unused,
    mkdir: unused,
    chmod: unused,
    rename: unused,
    unlink: unused,
    rmdir: unused,
  };
}

describe('installStackOverSsh', () => {
  const RUN = '/tmp/boundary-stack-install.Ab12Cd';
  const release: StackRelease = {
    version: 'v0.3.16',
    name: 'sovereign-agent-stack-v0.3.16',
    tarball: Buffer.from('tarball bytes'),
    sha256: 'e76f4daa732f15cbe181aff4b46247fb2382b571d1a60d07dab25b2b0213f02c',
    installScript: Buffer.from('#!/usr/bin/env bash\n'),
  };
  let files: Map<string, Buffer>;
  let modes: Map<string, number>;
  let commands: string[];
  let answers: { mktemp: { exitCode: number | null; stdout: string; stderr?: string }; launch: { exitCode: number; stderr?: string } };
  let sftp: SftpOps;

  const exec: SshExec = async (command, options) => {
    commands.push(command);
    if (command.includes('mktemp -d')) {
      options.onStdout(Buffer.from(answers.mktemp.stdout));
      if (answers.mktemp.stderr) options.onStderr(Buffer.from(answers.mktemp.stderr));
      return { exitCode: answers.mktemp.exitCode };
    }
    if (command.includes('nohup')) {
      if (answers.launch.stderr) options.onStderr(Buffer.from(answers.launch.stderr));
      return { exitCode: answers.launch.exitCode };
    }
    return { exitCode: 0 };
  };
  const log = (...lines: string[]) =>
    files.set(`${RUN}/install.log`, Buffer.concat([files.get(`${RUN}/install.log`) ?? Buffer.alloc(0), Buffer.from(lines.join(''))]));
  const exit = (code: number) => files.set(`${RUN}/install.exit`, Buffer.from(`${code}\n`));
  const install = (extra: Partial<StackInstallDeps> = {}) =>
    installStackOverSsh({ connection: { exec, sftp }, stackRoot: '/srv/stack', hostLabel: 'me@pc', release, pollMs: 1_000, ...extra });
  const removed = () => commands.some((c) => c.includes(`rm -rf ${RUN}`));
  const killed = () => commands.some((c) => c.includes('kill -TERM'));

  beforeEach(() => {
    vi.useFakeTimers();
    files = new Map();
    modes = new Map();
    commands = [];
    answers = { mktemp: { exitCode: 0, stdout: `${RUN}\n` }, launch: { exitCode: 0 } };
    sftp = memorySftp(files, modes);
  });
  afterEach(() => vi.useRealTimers());

  it('uploads the release, starts install.sh with the pinned checksum, follows its steps and returns its result', async () => {
    const steps: string[] = [];
    const done = install({ leaveOutModels: true, setupArgs: ['--db', '--research'], onStep: (s) => steps.push(`${s.step}:${s.status}`) });
    await vi.advanceTimersByTimeAsync(0);
    expect(files.get(`${RUN}/sovereign-agent-stack-v0.3.16.tar.gz`)).toEqual(release.tarball);
    expect(files.get(`${RUN}/install.sh`)).toEqual(release.installScript);
    expect(modes.get(`${RUN}/install.sh`)).toBe(0o600);
    const launch = commands.find((c) => c.includes('nohup'))!;
    expect(launch.startsWith(`cd ${RUN} && exec sh -c `)).toBe(true);
    expect(launch).toContain(
      ` sh bash install.sh --version v0.3.16 --dir /srv/stack --tarball ${RUN}/sovereign-agent-stack-v0.3.16.tar.gz` +
        ` --sha256 ${release.sha256} --json --skip-volume ollama_data -- --db --research`
    );

    // A line still being written waits for its newline.
    log(`${LINES.check}\n${LINES.verify}\n${LINES.stopRunning.slice(0, 20)}`);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(steps).toEqual(['check:done', 'verify:done']);
    log(`${LINES.stopRunning.slice(20)}\n== log text\n${LINES.stopDone}\n${LINES.upgraded}\n`);
    exit(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await done;
    expect(steps).toEqual(['check:done', 'verify:done', 'stop:running', 'stop:done']);
    expect(result).toMatchObject({ version: 'v0.3.16', previousVersion: 'v0.3.15', fresh: false });
    expect(result.needsUser.map((n) => n.id)).toEqual(['bitwarden-in-page-fill']);
    expect(removed()).toBe(true);
    expect(killed()).toBe(false);
  });

  it('passes neither --skip-volume nor -- unless asked, and reads a fresh install', async () => {
    const done = install();
    await vi.advanceTimersByTimeAsync(0);
    expect(commands.find((c) => c.includes('nohup'))).toMatch(/ --json$/);
    log(`${LINES.fresh}\n`);
    exit(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(done).resolves.toMatchObject({ fresh: true, previousVersion: null, needsUser: [] });
  });

  it("throws install.sh's own error with its step, log and backup", async () => {
    const done = install({ leaveOutModels: true }).catch((e: unknown) => e);
    log(`${LINES.check}\n${LINES.refused}\n`);
    exit(2);
    await vi.advanceTimersByTimeAsync(0);
    const error = (await done) as StackInstallError;
    expect(error).toBeInstanceOf(StackInstallError);
    expect(error).toMatchObject({ code: 'bad_input', step: 'backup', rolledBack: false, backup: null, runFolder: null });
    expect(error.message).toMatch(/backup refused its input/);
    expect(error.logTail).toHaveLength(1);
    expect(removed()).toBe(true);
  });

  it('names the exit status and stderr when install.sh ends without a result', async () => {
    const done = install().catch((e: unknown) => e);
    files.set(`${RUN}/install.err`, Buffer.from('bash: install.sh: line 1: killed\n'));
    exit(137);
    await vi.advanceTimersByTimeAsync(0);
    expect(await done).toMatchObject({
      code: 'no_result',
      message: expect.stringMatching(/exited with 137 without a result: bash: install\.sh: line 1: killed/),
      logTail: ['bash: install.sh: line 1: killed'],
    });
  });

  it('stops install.sh with TERM when cancelled or past its time limit, and leaves its output on the host', async () => {
    const cancel = new AbortController();
    const cancelled = install({ signal: cancel.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    cancel.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await cancelled).toMatchObject({ code: 'cancelled', runFolder: RUN, message: expect.stringContaining(`${RUN}/install.log`) });
    expect(killed()).toBe(true);
    expect(removed()).toBe(false);

    commands = [];
    const slow = install({ timeoutMs: 5_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(killed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await slow).toMatchObject({ code: 'timed_out', runFolder: RUN });
    expect(killed()).toBe(true);
  });

  it('reports a dropped connection without stopping the run', async () => {
    const done = install().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    sftp.readFile = () => Promise.reject(Object.assign(new Error('No SFTP connection'), { code: 4 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toMatchObject({
      code: 'connection_lost',
      runFolder: RUN,
      message: expect.stringMatching(/No SFTP connection.*It goes on there/),
    });
    expect(killed()).toBe(false);
    expect(removed()).toBe(false);
  });

  it("names why the run didn't start, and removes its folder", async () => {
    answers.mktemp = { exitCode: 1, stdout: '', stderr: 'mktemp: No space left on device\n' };
    await expect(install()).rejects.toMatchObject({ code: 'not_started', message: expect.stringMatching(/No space left/) });

    answers.mktemp = { exitCode: 0, stdout: `${RUN}\n` };
    answers.launch = { exitCode: 127, stderr: 'nohup is not installed\n' };
    await expect(install()).rejects.toMatchObject({ code: 'not_started', message: expect.stringMatching(/nohup is not installed/) });
    expect(removed()).toBe(true);

    await expect(install({ stackRoot: 'stack' })).rejects.toMatchObject({ code: 'bad_input' });
  });
});
