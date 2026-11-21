import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BOUNDARY_SETUP_WEBUI_TITLE,
  BOUNDARY_SETUP_WORKSPACE,
} from '../../../../shared/assistantStackConstants';
import { EventEmitter } from 'node:events';
import { spawnSync, type spawn } from 'node:child_process';
import {
  buildSovereignSetupArgs,
  buildSovereignSetupEnv,
  checkPython3ForSetup,
  ensureDockerCompatibleCliOnPath,
  python3SetupError,
  regenerateN8nCredentialsFromEnv,
  runSovereignSetup,
  __test,
} from '../runSovereignSetup';
import type { StackCommands } from '../../stackHost/types';

/** A spawn stand-in whose child exits with `code`, or errors when code is 'ENOENT'. */
function fakeSpawn(code: number | 'ENOENT'): typeof spawn {
  return (() => {
    const child = Object.assign(new EventEmitter(), { kill: () => true });
    setImmediate(() =>
      code === 'ENOENT' ? child.emit('error', new Error('spawn python3 ENOENT')) : child.emit('exit', code)
    );
    return child;
  }) as unknown as typeof spawn;
}

describe('runSovereignSetup helpers', () => {
  it('builds non-interactive setup.sh argv for Boundary profiles', () => {
    const args = buildSovereignSetupArgs({
      workspaceRoot: '/tmp/boundary-workspace',
    });
    expect(args).toEqual([
      'scripts/setup.sh',
      '--coding',
      '--db',
      '--non-interactive',
      '--workspace',
      BOUNDARY_SETUP_WORKSPACE,
      '--title',
      BOUNDARY_SETUP_WEBUI_TITLE,
      '--opencode-workspace',
      '/tmp/boundary-workspace',
    ]);
  });

  it('ensures PATH includes system bin dirs for openssl', () => {
    const env = buildSovereignSetupEnv({ PATH: '/custom/bin' });
    expect(env.PATH).toContain('/usr/bin');
    expect(env.PATH).toContain('/custom/bin');
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('keeps the stack scripts on the host python3 and node unless the env says otherwise', () => {
    const env = buildSovereignSetupEnv({ PATH: '/custom/bin' });
    expect(env.STACK_PYTHON).toBe('host');
    expect(env.N8N_NODE).toBe('host');
    const developer = buildSovereignSetupEnv({ PATH: '/custom/bin', STACK_PYTHON: '' });
    expect(developer.STACK_PYTHON).toBe('');
  });

  it('stubs node when it is missing: skips the n8n script, fails on anything else', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-node-stub-'));
    const shimDir = path.join(root, 'shim');
    try {
      const { env, stubbed } = await __test.ensureNodeOnPath({ PATH: '/nonexistent' }, shimDir);
      expect(stubbed).toBe(true);
      expect(env.PATH?.startsWith(`${shimDir}${path.delimiter}`)).toBe(true);
      const stub = path.join(shimDir, 'node');
      const run = (...args: string[]) => spawnSync('/bin/sh', [stub, ...args], { encoding: 'utf8' });
      expect(run('scripts/generate-n8n-credentials.js').status).toBe(0);
      const other = run('scripts/other.js');
      expect(other.status).toBe(127);
      expect(other.stderr).toContain('node is not installed; setup.sh ran: node scripts/other.js');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes n8n credentials from .env without spawning node', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-n8n-'));
    try {
      fs.writeFileSync(
        path.join(root, '.env'),
        'N8N_ENCRYPTION_KEY=enc\nLIGHTRAG_API_KEY=lr_key\nNEO4J_PASSWORD=pw\n'
      );
      await regenerateN8nCredentialsFromEnv({ projectRoot: root });
      const dir = path.join(root, 'n8n', 'demo-data', 'credentials');
      expect(fs.readdirSync(dir).sort()).toEqual(['LrH7tR4gApiKey01.json', 'N34jBas1cAuth001.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('shims docker → podman (+ docker-compose) when docker is absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-docker-shim-'));
    const binDir = path.join(root, 'bin');
    const shimDir = path.join(root, 'shim');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'podman'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'docker-compose'), '#!/bin/sh\n', { mode: 0o755 });

    const env = await ensureDockerCompatibleCliOnPath(
      { PATH: binDir },
      shimDir
    );
    const dockerShim = path.join(shimDir, 'docker');
    expect(fs.existsSync(dockerShim)).toBe(true);
    expect(env.PATH?.startsWith(`${shimDir}${path.delimiter}`)).toBe(true);
    const contents = fs.readFileSync(dockerShim, 'utf8');
    expect(contents).toContain(path.join(binDir, 'podman'));
    expect(contents).toContain(path.join(binDir, 'docker-compose'));
    expect(contents).toContain('if [ "$1" = "compose" ]');
  });
});

describe('checkPython3ForSetup', () => {
  it('passes with python3 3.9+', async () => {
    expect(await checkPython3ForSetup({}, fakeSpawn(0))).toBeNull();
  });

  it('flags a missing python3, including the macOS stub that exits non-zero', async () => {
    expect(await checkPython3ForSetup({}, fakeSpawn('ENOENT'))).toBe('missing');
    expect(await checkPython3ForSetup({}, fakeSpawn(1))).toBe('missing');
    expect(python3SetupError('missing')).toMatch(/xcode-select --install/);
  });

  it('flags a python3 older than 3.9', async () => {
    expect(await checkPython3ForSetup({}, fakeSpawn(3))).toBe('too-old');
    expect(python3SetupError('too-old')).toMatch(/3\.9 or newer/);
  });
});

describe('runSovereignSetup', () => {
  let projectRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-setup-'));
    projectRoot = path.join(tmp, 'stack');
    workspaceRoot = path.join(tmp, 'workspace');
    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'scripts', 'setup.sh'), '');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  });

  type Opts = Parameters<StackCommands['runScript']>[2];
  function run(behave: (o: Opts) => number, progress: string[] = []) {
    const calls: { script: string; args: string[]; options: Opts }[] = [];
    const runScript: StackCommands['runScript'] = async (script, args, options) => {
      calls.push({ script, args, options });
      return behave(options);
    };
    const done = runSovereignSetup({
      projectRoot,
      workspaceRoot,
      env: process.env,
      timeoutMs: 1234,
      onProgress: (m) => progress.push(m),
      runScript,
    });
    return { done, calls };
  }

  it('runs scripts/setup.sh with the setup arguments and reports [setup] lines as progress', async () => {
    const progress: string[] = [];
    const { done, calls } = run((o) => {
      o.onStdout('[setup] Generating secrets');
      return 0;
    }, progress);
    await done;
    expect(calls).toHaveLength(1);
    expect(calls[0].script).toBe('scripts/setup.sh');
    expect(calls[0].args).toEqual(buildSovereignSetupArgs({ workspaceRoot }).slice(1));
    expect(calls[0].options.timeoutMs).toBe(1234);
    expect(calls[0].options.input).toBeUndefined();
    expect(progress).toContain('[setup] Generating secrets');
  });

  it('throws with the exit code and the combined output when setup.sh fails', async () => {
    const { done } = run((o) => {
      o.onStdout('out line');
      o.onStderr('err line');
      return 2;
    });
    await expect(done).rejects.toThrow('setup.sh exited with code 2.\nerr line\n\nout line');
  });

  it('throws the timeout message when the host reports 124', async () => {
    const { done } = run(() => 124);
    await expect(done).rejects.toThrow('setup.sh timed out after 1234ms');
  });

  it('asks the host for the timeout line it reports on stderr', async () => {
    const { done, calls } = run(() => 0);
    await done;
    expect(calls[0].options.timeoutLine).toBe('setup.sh timed out after 1234ms');
  });
});
