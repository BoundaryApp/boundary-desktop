import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOUNDARY_ASSISTANT_PROJECT_NAME } from '../../../../shared/assistantStackConstants';

const fakes = await vi.hoisted(async () => (await import('./stackServiceMocks')).createComposeFakes());
const { local, checkout, installed } = vi.hoisted(() => ({
  local: { on: false },
  checkout: { root: '' },
  installed: { ids: [] as string[] },
}));

vi.mock('../../containerRuntime', async (importOriginal) =>
  (await import('./stackServiceMocks')).containerRuntimeMock(await importOriginal(), fakes)
);

vi.mock('../resolveAssistantRoot', async () =>
  (await import('./stackServiceMocks')).resolveAssistantRootMock(() => checkout.root)
);

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  ...(await import('./stackServiceMocks')).composePathMocks(),
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
import { onHermesReplaced } from '../hermesLifecycle';
import { composeCalls as parseComposeCalls, dockerRuntime } from './stackServiceMocks';

const { runCompose, runComposeStreaming, getContainerRuntime } = fakes;
const composeCalls = () => parseComposeCalls(runCompose);
const runtime = () =>
  dockerRuntime({ env: { PATH: '/usr/local/bin:/usr/bin', DOCKER_HOST: 'unix:///var/run/docker.sock' } });

describe('reloadHermesForAddons', () => {
  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-addon-reload-'));
    installed.ids = ['twenty'];
    local.on = false;
    runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    runComposeStreaming.mockReset();
    getContainerRuntime.mockResolvedValue(runtime());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
  });

  afterEach(() => {
    fs.rmSync(checkout.root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('runs both bootstraps forced, then recreates hermes, as make hermes-reload does', async () => {
    expect(await reloadHermesForAddons()).toEqual({ success: true });
    expect(composeCalls().map((c) => c.command)).toEqual([
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

describe('reloadHermesForAddons telling add-ons', () => {
  const replaced = vi.fn();
  let off: () => void = () => {};

  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-addon-reload-'));
    installed.ids = [];
    local.on = false;
    runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    getContainerRuntime.mockResolvedValue(runtime());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
    replaced.mockReset();
    off = onHermesReplaced(replaced);
  });

  afterEach(() => {
    off();
    fs.rmSync(checkout.root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('notifies addon-reload once after hermes is recreated', async () => {
    expect(await reloadHermesForAddons()).toEqual({ success: true });
    expect(replaced.mock.calls).toEqual([['addon-reload']]);
  });

  it('notifies addon-reload as soon as compose recreates hermes, even when the health wait then fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
    vi.useFakeTimers();
    try {
      const pending = reloadHermesForAddons();
      await vi.advanceTimersByTimeAsync(0);
      expect(replaced.mock.calls).toEqual([['addon-reload']]);
      await vi.advanceTimersByTimeAsync(130_000);
      expect((await pending).success).toBe(false);
      expect(replaced.mock.calls).toEqual([['addon-reload']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies nobody when the recreate fails', async () => {
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => {
      if (args.includes('--force-recreate')) throw new Error('up failed');
      return { stdout: '', stderr: '' };
    });
    expect((await reloadHermesForAddons()).success).toBe(false);
    expect(replaced).not.toHaveBeenCalled();
  });

  it('still succeeds when a listener rejects', async () => {
    off();
    off = onHermesReplaced(() => Promise.reject(new Error('follow failed')));
    expect(await reloadHermesForAddons()).toEqual({ success: true });
    await Promise.resolve();
  });
});

describe('getAssistantStackAccess for add-ons', () => {
  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-addon-access-'));
    installed.ids = [];
    local.on = false;
    runComposeStreaming.mockReset().mockResolvedValue({ stdout: '', stderr: '', code: 0, timedOut: false });
    getContainerRuntime.mockResolvedValue(runtime());
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
