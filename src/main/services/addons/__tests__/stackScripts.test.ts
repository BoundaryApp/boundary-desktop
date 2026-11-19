import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({
  root: '',
  dataRoot: '',
  scriptEnv: async (profiles: string[]): Promise<NodeJS.ProcessEnv> => ({ COMPOSE_PROFILES: ['core', ...profiles].join(','), COMPOSE_PROJECT_NAME: 'proj' }),
}));
const runtime = vi.hoisted(() => ({ cliPath: '/bin/docker', composeArgv: ['compose'], env: {} }));
const runCompose = vi.hoisted(() => vi.fn(async () => ({ stdout: 'compose-out\n', stderr: '' })));
const runCli = vi.hoisted(() => vi.fn(async () => ({ stdout: 'cli-out\n', stderr: '' })));

vi.mock('../../assistant/AssistantStackService', () => ({
  getAssistantStackAccess: () => access,
}));
vi.mock('../../containerRuntime', () => ({ getContainerRuntime: async () => runtime, runCompose, runCli }));

import { readActualRows } from '../actualAddon';
import { cliOnStack, composeOnStack, stackPaths } from '../stackScripts';

describe('composeOnStack and cliOnStack', () => {
  it('run in the stack root with the environment vault.sh gets, plus the named profiles', async () => {
    access.root = '/stack';
    expect(await composeOnStack(['ps', '-q', 'hermes'], { profiles: ['bitwarden'], timeoutMs: 5_000 })).toBe('compose-out\n');
    expect(runCompose).toHaveBeenCalledWith(runtime, ['ps', '-q', 'hermes'], {
      cwd: '/stack',
      env: { COMPOSE_PROFILES: 'core,bitwarden', COMPOSE_PROJECT_NAME: 'proj' },
      timeout: 5_000,
    });
    expect(await cliOnStack(['inspect', 'x'], { timeoutMs: 5_000 })).toBe('cli-out\n');
    expect(runCli).toHaveBeenCalledWith(runtime, ['inspect', 'x'], {
      cwd: '/stack',
      env: { COMPOSE_PROFILES: 'core', COMPOSE_PROJECT_NAME: 'proj' },
      timeout: 5_000,
    });
  });
});

// The stack's add-on scripts keep their stores under ASSISTANT_DATA_ROOT from its .env
// (scripts/lib/data-root.sh resolve_data_root_path), falling back to <stack root>/data.

describe('stackPaths', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-paths-'));
    access.root = path.join(tmp, 'stack');
    access.dataRoot = path.join(access.root, 'data');
    fs.mkdirSync(access.root, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses <stack root>/data when the .env sets no ASSISTANT_DATA_ROOT', () => {
    fs.writeFileSync(path.join(access.root, '.env'), 'ACTUAL_MCP_ENABLED=1\n');
    expect(stackPaths()).toEqual({ root: access.root, dataRoot: path.join(access.root, 'data') });
  });

  it('follows ASSISTANT_DATA_ROOT outside the stack root, where the stack writes Actual rows', () => {
    const relocated = path.join(tmp, 'AssistantData');
    fs.writeFileSync(path.join(access.root, '.env'), `ASSISTANT_DATA_ROOT=${relocated}\nACTUAL_MCP_ENABLED=1\n`);
    const instances = path.join(relocated, 'addons', 'actual', 'instances');
    fs.mkdirSync(instances, { recursive: true });
    fs.writeFileSync(
      path.join(instances, 'my-finances.json'),
      JSON.stringify({ server: 'https://budget.example.com', sync_id: 'abc', bind: { default: 'rw' } })
    );

    const { dataRoot } = stackPaths();
    expect(dataRoot).toBe(relocated);
    expect(readActualRows(dataRoot).map((r) => [r.slug, r.local])).toEqual([['my-finances', false]]);
    // The old reading of <stack root>/data found nothing.
    expect(readActualRows(access.dataRoot)).toEqual([]);
  });

  it('resolves a relative ASSISTANT_DATA_ROOT against the stack root', () => {
    fs.writeFileSync(path.join(access.root, '.env'), 'ASSISTANT_DATA_ROOT=./elsewhere\n');
    expect(stackPaths().dataRoot).toBe(path.join(access.root, 'elsewhere'));
  });
});
