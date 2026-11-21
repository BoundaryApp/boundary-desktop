import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteCommand, shellQuote, sshStackCommands, type SshExec } from '../sshStackCommands';
import { shExec } from './sshTestDoubles';

describe('shellQuote and remoteCommand', () => {
  it('quotes words a shell would split or expand', () => {
    expect(shellQuote('scripts/env.sh')).toBe('scripts/env.sh');
    expect(shellQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    expect(shellQuote('')).toBe("''");
  });

  it('refuses an environment name the shell would read as a command', () => {
    expect(() => remoteCommand('/s', ['true'], { 'A;rm': 'x' })).toThrow(/Not an environment variable name/);
  });
});

describe('sshStackCommands', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh stack '));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(
      path.join(root, 'scripts', 'echo.sh'),
      [
        'printf "arg:%s\\n" "$@"',
        'printf "client:%s\\n" "${STACK_CLIENT:-}"',
        'printf "profiles:%s\\n" "${COMPOSE_PROFILES:-}"',
        'IFS= read -r line || true; printf "stdin:%s\\n" "$line"',
        'echo "to stderr" >&2',
        'exit "${EXIT_WITH:-0}"',
      ].join('\n')
    );
    fs.writeFileSync(path.join(root, 'scripts', 'sleep.sh'), 'sleep 30\n');
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const commandsAt = (exec: SshExec, envProfiles: string | null = null) =>
    sshStackCommands({ exec, stackRoot: root, envProfiles: async () => envProfiles });

  async function runEcho(commands: ReturnType<typeof commandsAt>, args: string[], env: NodeJS.ProcessEnv, input?: string) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await commands.runScript('scripts/echo.sh', args, {
      env,
      input,
      timeoutMs: 10_000,
      timeoutLine: 'too slow',
      onStdout: (line) => out.push(line),
      onStderr: (line) => err.push(line),
    });
    return { code, out, err };
  }

  it('runs a script from the stack folder with its arguments, environment and stdin, word for word', async () => {
    const { exec } = shExec();
    const result = await runEcho(commandsAt(exec), ['set', "a b'c", '$HOME'], { STACK_CLIENT: 'boundary' }, '{"x":1}');
    expect(result).toEqual({
      code: 0,
      out: ['arg:set', "arg:a b'c", 'arg:$HOME', 'client:boundary', 'profiles:', 'stdin:{"x":1}'],
      err: ['to stderr'],
    });
  });

  it('passes the exit code through', async () => {
    const { exec } = shExec();
    expect((await runEcho(commandsAt(exec), [], { EXIT_WITH: '2' })).code).toBe(2);
  });

  it('leaves out variables this machine’s own environment already has', async () => {
    const { exec, commands } = shExec();
    await runEcho(commandsAt(exec), [], { ...process.env, STACK_CLIENT: 'boundary' });
    expect(commands[0]).toContain('STACK_CLIENT=boundary');
    expect(commands[0]).not.toContain('PATH=');
  });

  it('adds profiles to the ones the host’s .env turns on', async () => {
    const { exec } = shExec();
    const commands = commandsAt(exec, 'core,research');
    expect(await commands.scriptEnv([])).toEqual({});
    const env = await commands.scriptEnv(['bitwarden', 'core']);
    expect(env).toEqual({ COMPOSE_PROFILES: 'core,research,bitwarden' });
    expect((await runEcho(commands, [], env)).out).toContain('profiles:core,research,bitwarden');
    expect(await commandsAt(exec, null).scriptEnv(['crm'])).toEqual({ COMPOSE_PROFILES: 'core,crm' });
  });

  it('stops a script past its time limit with 124 and the time-out line', async () => {
    const { exec } = shExec();
    const err: string[] = [];
    const code = await commandsAt(exec).runScript('scripts/sleep.sh', [], {
      env: {},
      timeoutMs: 50,
      timeoutLine: 'sleep.sh ran too long',
      onStdout: () => undefined,
      onStderr: (line) => err.push(line),
    });
    expect(code).toBe(124);
    expect(err).toContain('sleep.sh ran too long');
  });

  it('answers 130 when cancelled', async () => {
    const { exec } = shExec();
    const stop = new AbortController();
    const running = commandsAt(exec).runScript('scripts/sleep.sh', [], {
      env: {},
      timeoutMs: 10_000,
      timeoutLine: '',
      signal: stop.signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    stop.abort();
    expect(await running).toBe(130);
  });

  it('answers 127 when the channel can’t be opened', async () => {
    const err: string[] = [];
    const exec: SshExec = async () => {
      throw new Error('Channel open failure');
    };
    const code = await commandsAt(exec).runScript('scripts/echo.sh', [], {
      env: {},
      timeoutMs: 1000,
      timeoutLine: '',
      onStdout: () => undefined,
      onStderr: (line) => err.push(line),
    });
    expect(code).toBe(127);
    expect(err).toEqual(['Channel open failure']);
  });

  it('runs compose as docker compose from the stack folder and rejects with its last stderr line', async () => {
    const { commands } = shExec();
    const exec: SshExec = async (command, options) => {
      commands.push(command);
      options.onStderr(Buffer.from('pulling\nno such service: x\n'));
      return { exitCode: 1 };
    };
    await expect(commandsAt(exec).compose(['up', '-d', 'x'])).rejects.toThrow('docker compose up exited with 1: no such service: x');
    expect(commands[0]).toBe(`cd ${shellQuote(root)} && exec docker compose up -d x`);
  });
});
