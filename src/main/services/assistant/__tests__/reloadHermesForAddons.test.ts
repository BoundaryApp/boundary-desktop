import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../../shared/assistantStackConstants';

const runCompose = vi.fn();
const runComposeStreaming = vi.fn();
const getContainerRuntime = vi.fn();
const { local, checkout, installed } = vi.hoisted(() => ({
  local: { on: false },
  checkout: { root: '' },
  installed: { ids: [] as string[] },
}));

vi.mock('../../containerRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../containerRuntime')>(
    '../../containerRuntime'
  );
  return {
    ...actual,
    getContainerRuntime: (...args: unknown[]) => getContainerRuntime(...args),
    runCompose: (...args: unknown[]) => runCompose(...args),
    runComposeStreaming: (...args: unknown[]) => runComposeStreaming(...args),
  };
});

vi.mock('../resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: checkout.root, error: undefined }),
  resolveAssistantRoot: () => checkout.root,
}));

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
}));

vi.mock('../localStackMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../localStackMode')>()),
  isLocalAssistantStackMode: () => local.on,
  stackMode: () => ({
    kind: local.on ? 'local' : 'managed',
    root: checkout.root,
    source: local.on ? 'BOUNDARY_ASSISTANT_ROOT' : 'managed',
    attachLive: false,
  }),
}));

vi.mock('../AssistantStackStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../AssistantStackStore')>()),
  getInstalledAddons: () => installed.ids,
}));

import { getAssistantStackAccess, reloadHermesForAddons } from '../AssistantStackService';

function composeCalls(): Array<{ args: string[]; env: NodeJS.ProcessEnv }> {
  return runCompose.mock.calls.map((c) => ({ args: c[1] as string[], env: (c[2] as { env: NodeJS.ProcessEnv }).env }));
}

/** The arguments after the compose file and project flags. */
function command(args: string[]): string[] {
  const at = args.findIndex((a) => a === 'run' || a === 'up');
  return args.slice(at);
}

describe('reloadHermesForAddons', () => {
  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-addon-reload-'));
    installed.ids = ['twenty'];
    local.on = false;
    runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    runComposeStreaming.mockReset();
    getContainerRuntime.mockResolvedValue({
      kind: 'docker',
      origin: 'system',
      cliPath: 'docker',
      composeArgv: ['compose'],
      env: { PATH: '/usr/local/bin:/usr/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' },
      apiEndpoint: 'unix:///var/run/docker.sock',
      version: { cli: '1', compose: '2.38.2' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
  });

  afterEach(() => {
    fs.rmSync(checkout.root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('runs both bootstraps forced, then recreates hermes, as make hermes-reload does', async () => {
    expect(await reloadHermesForAddons()).toEqual({ success: true });
    expect(composeCalls().map((c) => command(c.args))).toEqual([
      ['run', '--rm', '-e', 'HERMES_BOOTSTRAP_FORCE=1', 'hermes-api-bootstrap'],
      ['run', '--rm', '--no-deps', '-e', 'HERMES_BOOTSTRAP_FORCE=1', 'hermes-browser-bootstrap'],
      ['up', '-d', '--no-deps', '--force-recreate', 'hermes'],
    ]);
    for (const { args, env } of composeCalls()) {
      expect(args).toContain('crm');
      expect(env.TWENTY_LOCAL_ENABLED).toBe('1');
      expect(env.TWENTY_MCP_ENABLED).toBe('1');
    }
  });

  it('passes the add-on flags in local stack mode, which adds none of its own', async () => {
    local.on = true;
    expect(await reloadHermesForAddons()).toEqual({ success: true });
    expect(runCompose).toHaveBeenCalledTimes(3);
    for (const { args, env } of composeCalls()) {
      expect(args).not.toContain('--profile');
      expect(env).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
    }
  });

  it('reports a failed bootstrap without recreating hermes', async () => {
    runCompose.mockRejectedValueOnce(new Error('bootstrap exited 1'));
    expect(await reloadHermesForAddons()).toEqual({ success: false, error: 'bootstrap exited 1' });
    expect(runCompose).toHaveBeenCalledTimes(1);
  });
});

describe('getAssistantStackAccess for add-ons', () => {
  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-addon-access-'));
    installed.ids = [];
    local.on = false;
    runComposeStreaming.mockReset().mockResolvedValue({ stdout: '', stderr: '', code: 0, timedOut: false });
    getContainerRuntime.mockResolvedValue({
      kind: 'docker',
      origin: 'system',
      cliPath: 'docker',
      composeArgv: ['compose'],
      env: { PATH: '/usr/local/bin:/usr/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' },
      apiEndpoint: 'unix:///var/run/docker.sock',
      version: { cli: '1', compose: '2.38.2' },
    });
  });

  afterEach(() => {
    fs.rmSync(checkout.root, { recursive: true, force: true });
  });

  it('streams compose lines with the env given, over Boundary’s own', async () => {
    const onLine = vi.fn();
    await getAssistantStackAccess().composeStreaming(['pull'], { onLine, env: { TWENTY_LOCAL_ENABLED: '1' } });
    const options = runComposeStreaming.mock.calls[0][2] as {
      env: NodeJS.ProcessEnv;
      onStdoutLine: unknown;
      onStderrLine: unknown;
    };
    expect(options.onStdoutLine).toBe(onLine);
    expect(options.onStderrLine).toBe(onLine);
    expect(options.env.TWENTY_LOCAL_ENABLED).toBe('1');
    expect(options.env.TWENTY_MCP_ENABLED).toBe('0');
    expect(options.env.BOUNDARY_ASSISTANT_DATA).toBeTruthy();
  });

  it('points a script’s docker compose at Boundary’s project in managed mode', async () => {
    const env = await getAssistantStackAccess().scriptEnv(['crm']);
    expect(env.COMPOSE_PROJECT_NAME).toBe(BOUNDARY_ASSISTANT_PROJECT_NAME);
    expect(env.COMPOSE_FILE?.split(':')).toEqual(['docker-compose.yml', '/tmp/docker-compose.boundary.yml']);
    expect(env.COMPOSE_PROFILES?.split(',')).toContain('crm');
    expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    expect(env.PATH?.split(':')).toContain('/usr/local/bin');
  });

  it('adds the profile to the checkout’s own profiles in local mode', async () => {
    local.on = true;
    fs.writeFileSync(path.join(checkout.root, '.env'), 'COMPOSE_PROFILES=core,rag\n', 'utf8');
    const env = await getAssistantStackAccess().scriptEnv(['crm']);
    expect(env.COMPOSE_PROFILES).toBe('core,rag,crm');
    expect(env.COMPOSE_PROJECT_NAME).toBeUndefined();
    expect(env.COMPOSE_FILE).toBeUndefined();
  });
});
