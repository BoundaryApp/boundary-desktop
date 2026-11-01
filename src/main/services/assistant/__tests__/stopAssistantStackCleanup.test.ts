import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot } from '../../../../shared/assistantStackLifecycle';

const runComposeStreaming = vi.fn();
const runCompose = vi.fn();
const runCli = vi.fn();
const getContainerRuntime = vi.fn();

const { isLocalAssistantStackMode } = vi.hoisted(() => ({
  isLocalAssistantStackMode: vi.fn(() => false),
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
    runCli: (...args: unknown[]) => runCli(...args),
  };
});

vi.mock('../resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({
    root: '/tmp/fake-assistant',
    error: undefined,
  }),
  resolveAssistantRoot: () => '/tmp/fake-assistant',
}));

vi.mock('../assistantPaths', () => ({
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantDataRoot: () => '/tmp/assistant-data',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  resolveAssistantProjectRoot: () => '/tmp/fake-assistant',
  resolveAssistantStackHome: () => '/tmp/assistant-stack-home',
  isBoundaryOwnedAssistantRoot: () => false,
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
  ensureAssistantDataDirs: async () => undefined,
  ensureAssistantWorkspaceDir: async () => undefined,
  hermesConfigExists: () => true,
  removeIncompleteHermesProfiles: async () => undefined,
}));

vi.mock('../provisionSovereignStack', () => ({
  ensureSovereignProjectProvisioned: async () => '/tmp/fake-assistant',
  isHostSetupComplete: () => true,
  markHostSetupComplete: async () => undefined,
  needsImageBuild: () => false,
  markImagesBuilt: async () => undefined,
}));

vi.mock('../runSovereignSetup', () => ({
  runSovereignSetup: async () => undefined,
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: async () => undefined,
  clearLlmKeysFromProjectEnv: async () => false,
}));

vi.mock('../localStackMode', () => ({
  isLocalAssistantStackMode: (...args: unknown[]) => isLocalAssistantStackMode(...args),
  localStackStopSkippedMessage: () => 'Local mode: leave stack running',
}));

vi.mock('../AssistantStackStore', async () => {
  const actual = await vi.importActual<typeof import('../AssistantStackStore')>(
    '../AssistantStackStore'
  );
  return {
    ...actual,
    getAssistantRootOverride: () => '/tmp/fake-assistant',
  };
});

describe('stopAssistantStack cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    isLocalAssistantStackMode.mockReset();
    isLocalAssistantStackMode.mockReturnValue(false);
    runComposeStreaming.mockReset();
    runCompose.mockReset();
    runCli.mockReset();
    getContainerRuntime.mockReset();

    getContainerRuntime.mockResolvedValue({
      kind: 'docker',
      origin: 'system',
      cliPath: 'docker',
      composeArgv: ['compose'],
      env: {},
      apiEndpoint: 'unix:///var/run/docker.sock',
      version: { cli: '1', compose: '2' },
    });

    runComposeStreaming.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    runCompose.mockResolvedValue({ stdout: '[]', stderr: '' });
    runCli.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('stops the containers and keeps them, their volumes and their images', async () => {
    const { stopAssistantStack, __test } = await import('../AssistantStackService');
    __test.resetLifecycle();

    const result = await stopAssistantStack();
    expect(result.success).toBe(true);

    expect(runComposeStreaming).toHaveBeenCalled();
    const args = runComposeStreaming.mock.calls[0][1] as string[];
    expect(args).toContain('stop');
    expect(args).toContain('--progress');
    expect(args).toContain('json');
    expect(args).not.toContain('down');
    expect(args).not.toContain('--volumes');
    expect(args).not.toContain('--rmi');

    // A volume prune would delete the named volumes on Podman.
    expect(runCli).not.toHaveBeenCalled();

    expect(__test.getLifecycleSnapshot().phase).toBe('stopped');
  });

  it('skips compose stop in local-stack mode', async () => {
    isLocalAssistantStackMode.mockReturnValue(true);
    const { stopAssistantStack, __test } = await import('../AssistantStackService');
    __test.resetLifecycle();

    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready'));

    const result = await stopAssistantStack();
    expect(result.success).toBe(true);
    expect(runComposeStreaming).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    // No 'stopping'/'stopped' phase: either one shows the quit overlay.
    expect(__test.getLifecycleSnapshot().phase).toBe('ready');
  });

  it('announces nothing on quit in local-stack mode', async () => {
    isLocalAssistantStackMode.mockReturnValue(true);
    const { announceAssistantStackStopping, __test } = await import(
      '../AssistantStackService'
    );
    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready'));
    announceAssistantStackStopping();
    expect(__test.getLifecycleSnapshot().phase).toBe('ready');
  });

  it('announceAssistantStackStopping sets stopping phase', async () => {
    const { announceAssistantStackStopping, __test } = await import(
      '../AssistantStackService'
    );
    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready'));
    announceAssistantStackStopping();
    expect(__test.getLifecycleSnapshot().phase).toBe('stopping');
  });
});
