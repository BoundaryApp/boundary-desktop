import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCompose = vi.fn();
const getContainerRuntime = vi.fn();
const { lightrag, mode } = vi.hoisted(() => ({
  lightrag: { enabled: false },
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
  isLightragEnabled: () => lightrag.enabled,
  setLightragEnabled: (enabled: boolean) => {
    lightrag.enabled = enabled;
  },
}));

import { setLightragRunning, __test } from '../AssistantStackService';

interface ComposeCall {
  /** Every `--profile` the call names. */
  profiles: string[];
  /** The compose subcommand and what follows it. */
  command: string[];
  env: NodeJS.ProcessEnv;
}

function composeCalls(): ComposeCall[] {
  return runCompose.mock.calls.map((call) => {
    const args = call[1] as string[];
    const profiles = args.flatMap((arg, i) => (args[i - 1] === '--profile' ? [arg] : []));
    const at = args.findIndex((arg) => ['up', 'rm', 'run'].includes(arg));
    return { profiles, command: args.slice(at), env: (call[2] as { env: NodeJS.ProcessEnv }).env };
  });
}

describe('setLightragRunning', () => {
  let healthy = true;

  beforeEach(() => {
    lightrag.enabled = false;
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

  it('starts the rag services, then has Hermes register LightRAG', async () => {
    expect(await setLightragRunning(true)).toEqual({ success: true });
    expect(lightrag.enabled).toBe(true);
    const calls = composeCalls();
    expect(calls.map((call) => call.command)).toEqual([
      ['up', '-d', 'lightrag-mcp', 'lightrag', 'neo4j'],
      ['run', '--rm', '-e', 'HERMES_BOOTSTRAP_FORCE=1', 'hermes-api-bootstrap'],
      ['run', '--rm', '--no-deps', '-e', 'HERMES_BOOTSTRAP_FORCE=1', 'hermes-browser-bootstrap'],
      ['up', '-d', '--no-deps', '--force-recreate', 'hermes'],
    ]);
    for (const call of calls) {
      expect(call.profiles).toContain('rag');
      expect(call.env.LIGHTRAG_MCP_ENABLED).toBe('1');
      expect(call.env.COMPOSE_PROFILES?.split(',')).toContain('rag');
    }
  });

  it('removes the rag containers, not their volumes, when turned off', async () => {
    lightrag.enabled = true;
    expect(await setLightragRunning(false)).toEqual({ success: true });
    expect(lightrag.enabled).toBe(false);
    const [call, ...rest] = composeCalls();
    expect(rest).toEqual([]);
    expect(call.command).toEqual(['rm', '-sf', 'lightrag-mcp', 'lightrag', 'neo4j']);
    expect(call.profiles).toContain('rag');
    expect(call.env.LIGHTRAG_MCP_ENABLED).toBe('0');
    expect(call.env.COMPOSE_PROFILES?.split(',')).not.toContain('rag');
  });

  it('removes the containers when turned off while the stack is down', async () => {
    lightrag.enabled = true;
    healthy = false;
    expect(await setLightragRunning(false)).toEqual({ success: true });
    expect(composeCalls().map((call) => call.command[0])).toEqual(['rm']);
  });

  it('only saves the setting when turned on while the stack is down', async () => {
    healthy = false;
    expect(await setLightragRunning(true)).toEqual({ success: true });
    expect(lightrag.enabled).toBe(true);
    expect(runCompose).not.toHaveBeenCalled();
  });

  it('puts the setting back when LightRAG fails to start', async () => {
    runCompose.mockRejectedValue(new Error('pull failed'));
    const result = await setLightragRunning(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Couldn’t start LightRAG');
    expect(lightrag.enabled).toBe(false);
  });

  it('puts the setting back when Hermes fails to restart', async () => {
    runCompose
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('bootstrap exited 1'));
    const result = await setLightragRunning(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('bootstrap exited 1');
    expect(lightrag.enabled).toBe(false);
  });

  it('leaves the choice to the local stack’s .env under dev:local-stack', async () => {
    mode.attachLive = true;
    const result = await setLightragRunning(true);
    expect(result.success).toBe(false);
    expect(lightrag.enabled).toBe(false);
    expect(runCompose).not.toHaveBeenCalled();
  });
});
