import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCompose = vi.fn();
const getContainerRuntime = vi.fn();
const { saved, mode, pin } = vi.hoisted(() => ({
  saved: { mode: 'private' as string },
  mode: { attachLive: false },
  pin: { version: 'v0.3.11' },
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

vi.mock('../../../../shared/assistantStackConstants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/assistantStackConstants')>();
  return {
    ...actual,
    get SOVEREIGN_AGENT_STACK_VERSION() {
      return pin.version;
    },
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
    stackMode: () => ({ ...actual.stackMode(), attachLive: mode.attachLive }),
  };
});

vi.mock('../AssistantStackStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../AssistantStackStore')>()),
  getWebSearchMode: () => saved.mode,
  setWebSearchMode: (next: string) => {
    saved.mode = next;
  },
}));

import { getWebSearchModeState, setWebSearchModeRunning, __test } from '../AssistantStackService';

function composeCalls(): Array<{ command: string[]; env: NodeJS.ProcessEnv }> {
  return runCompose.mock.calls.map((call) => {
    const args = call[1] as string[];
    const at = args.findIndex((arg) => ['up', 'rm', 'run'].includes(arg));
    return { command: args.slice(at), env: (call[2] as { env: NodeJS.ProcessEnv }).env };
  });
}

describe('setWebSearchModeRunning', () => {
  let healthy = true;

  beforeEach(() => {
    saved.mode = 'private';
    mode.attachLive = false;
    pin.version = 'v0.3.11';
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

  it('saves the mode and recreates hermes with it in the compose env', async () => {
    expect(await setWebSearchModeRunning('private-first')).toEqual({ success: true });
    expect(saved.mode).toBe('private-first');
    const calls = composeCalls();
    expect(calls.map((call) => call.command)).toEqual([['up', '-d', '--no-deps', 'hermes']]);
    expect(calls[0].env.HERMES_WEB_SEARCH_MODE).toBe('private-first');
  });

  it('only saves the mode while the stack is down', async () => {
    healthy = false;
    expect(await setWebSearchModeRunning('keyless')).toEqual({ success: true });
    expect(saved.mode).toBe('keyless');
    expect(runCompose).not.toHaveBeenCalled();
  });

  it('does nothing when the mode is unchanged', async () => {
    expect(await setWebSearchModeRunning('private')).toEqual({ success: true });
    expect(runCompose).not.toHaveBeenCalled();
  });

  it('puts the mode back when hermes fails to restart', async () => {
    runCompose.mockRejectedValue(new Error('recreate failed'));
    const result = await setWebSearchModeRunning('keyless-first');
    expect(result.success).toBe(false);
    expect(result.error).toContain('recreate failed');
    expect(saved.mode).toBe('private');
  });

  it('refuses an unknown mode', async () => {
    const result = await setWebSearchModeRunning('KEYLESS');
    expect(result.success).toBe(false);
    expect(saved.mode).toBe('private');
    expect(runCompose).not.toHaveBeenCalled();
  });

  it('refuses on a stack pin that predates the setting', async () => {
    pin.version = 'v0.3.10';
    const result = await setWebSearchModeRunning('keyless');
    expect(result.success).toBe(false);
    expect(result.error).toContain('v0.3.11');
    expect(saved.mode).toBe('private');
  });

  it('leaves the choice to the local stack’s .env under dev:local-stack', async () => {
    mode.attachLive = true;
    const result = await setWebSearchModeRunning('keyless');
    expect(result.success).toBe(false);
    expect(saved.mode).toBe('private');
    expect((await getWebSearchModeState()).canChange).toBe(false);
  });

  it('reports availability from the stack pin', async () => {
    expect((await getWebSearchModeState()).available).toBe(true);
    pin.version = 'v0.3.10';
    expect(await getWebSearchModeState()).toMatchObject({ available: false, mode: 'private', overrides: [] });
  });
});
