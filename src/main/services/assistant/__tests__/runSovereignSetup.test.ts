import { describe, expect, it } from 'vitest';
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
  __test,
} from '../runSovereignSetup';

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
      '--rag',
      '--automation',
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
