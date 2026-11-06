import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCompose = vi.fn();
const getContainerRuntime = vi.fn();
const { n8n, mode } = vi.hoisted(() => ({
  n8n: { enabled: false },
  mode: { attachLive: false },
}));

vi.mock('../../containerRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../containerRuntime')>(
    '../../containerRuntime'
  );
  return {
    ...actual,
    getContainerRuntime: (...args: unknown[]) => getContainerRuntime(...args),
    runCompose: (...args: unknown[]) => runCompose(...args),
  };
});

vi.mock('../resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: '/tmp/boundary-project', error: undefined }),
  resolveAssistantRoot: () => '/tmp/boundary-project',
}));

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantDataRoot: () => '/tmp/boundary-project/data',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
}));

vi.mock('../localStackMode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../localStackMode')>();
  return {
    ...actual,
    stackMode: () => ({
      ...actual.stackMode(),
      attachLive: mode.attachLive,
    }),
  };
});

vi.mock('../AssistantStackStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../AssistantStackStore')>()),
  isN8nEnabled: () => n8n.enabled,
  setN8nEnabled: (enabled: boolean) => {
    n8n.enabled = enabled;
  },
}));

import { setN8nRunning, __test } from '../AssistantStackService';

/** The compose subcommand and what follows it, without the project and profile flags. */
function composeCommand(): string[] {
  expect(runCompose).toHaveBeenCalledTimes(1);
  const args = runCompose.mock.calls[0][1] as string[];
  const at = args.findIndex((arg) => arg === 'up' || arg === 'rm');
  return args.slice(at);
}

describe('setN8nRunning', () => {
  let healthy = true;

  beforeEach(() => {
    n8n.enabled = false;
    mode.attachLive = false;
    healthy = true;
    runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    getContainerRuntime.mockResolvedValue({
      kind: 'docker',
      origin: 'system',
      cliPath: 'docker',
      composeArgv: ['compose'],
      env: {},
      apiEndpoint: 'unix:///var/run/docker.sock',
      version: { cli: '1', compose: '2.38.2' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: healthy })) as unknown as typeof fetch);
  });

  afterEach(() => {
    __test.resetReadyForTests();
    vi.unstubAllGlobals();
  });

  it('starts n8n and its seed job on a running stack', async () => {
    expect(await setN8nRunning(true)).toEqual({ success: true });
    expect(n8n.enabled).toBe(true);
    expect(composeCommand()).toEqual(['up', '-d', 'n8n-import', 'n8n', 'gpt-researcher']);
  });

  it('stops and removes n8n’s containers, not its volume, when turned off', async () => {
    n8n.enabled = true;
    expect(await setN8nRunning(false)).toEqual({ success: true });
    expect(n8n.enabled).toBe(false);
    expect(composeCommand()).toEqual(['rm', '-sf', 'n8n-import', 'n8n', 'gpt-researcher']);
  });

  it('only saves the setting while the stack is down', async () => {
    healthy = false;
    expect(await setN8nRunning(true)).toEqual({ success: true });
    expect(n8n.enabled).toBe(true);
    expect(runCompose).not.toHaveBeenCalled();
  });

  it('puts the setting back when n8n fails to start', async () => {
    runCompose.mockRejectedValue(new Error('pull failed'));
    const result = await setN8nRunning(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Couldn’t start n8n');
    expect(n8n.enabled).toBe(false);
  });

  it('leaves the choice to the local stack’s .env under dev:local-stack', async () => {
    mode.attachLive = true;
    const result = await setN8nRunning(true);
    expect(result.success).toBe(false);
    expect(n8n.enabled).toBe(false);
    expect(runCompose).not.toHaveBeenCalled();
  });
});
