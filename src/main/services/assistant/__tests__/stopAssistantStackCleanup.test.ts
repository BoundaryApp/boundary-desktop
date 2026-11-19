import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __test,
  announceAssistantStackStopping,
  stopAssistantStack,
} from '../AssistantStackService';
import { createLifecycleSnapshot } from '../../../../shared/assistantStackLifecycle';
import { dockerRuntime } from './stackServiceMocks';

const fakes = await vi.hoisted(async () => (await import('./stackServiceMocks')).createComposeFakes());

const installedAddons = vi.hoisted(() => ({ ids: [] as string[] }));

const { isLocalAssistantStackMode } = vi.hoisted(() => ({
  isLocalAssistantStackMode: vi.fn(() => false),
}));

vi.mock('../../containerRuntime', async (importOriginal) =>
  (await import('./stackServiceMocks')).containerRuntimeMock(await importOriginal(), fakes)
);

vi.mock('../resolveAssistantRoot', async () =>
  (await import('./stackServiceMocks')).resolveAssistantRootMock(() => '/tmp/fake-assistant')
);

vi.mock('../assistantPaths', async () => ({
  ...(await import('./stackServiceMocks')).composePathMocks(),
  resolveAssistantDataRoot: () => '/tmp/assistant-data',
  resolveAssistantUserContentRoot: () => '/tmp/assistant-data',
  resolveAssistantProjectRoot: () => '/tmp/fake-assistant',
  resolveAssistantStackHome: () => '/tmp/assistant-stack-home',
  isBoundaryOwnedAssistantRoot: () => false,
  ensureAssistantDataDirs: async (): Promise<void> => undefined,
  ensureAddonMountSources: async (): Promise<void> => undefined,
  ensureAssistantWorkspaceDir: async (): Promise<void> => undefined,
  hermesConfigExists: () => true,
  removeIncompleteHermesProfiles: async (): Promise<void> => undefined,
}));

vi.mock('../provisionSovereignStack', () => ({
  ensureSovereignProjectProvisioned: async () => '/tmp/fake-assistant',
  isHostSetupComplete: () => true,
  markHostSetupComplete: async (): Promise<void> => undefined,
  needsImageBuild: () => false,
  markImagesBuilt: async (): Promise<void> => undefined,
}));

vi.mock('../runSovereignSetup', () => ({
  runSovereignSetup: async (): Promise<void> => undefined,
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: async (): Promise<void> => undefined,
  clearLlmKeysFromProjectEnv: async () => false,
}));

vi.mock('../localStackMode', () => ({
  isLocalAssistantStackMode: () => isLocalAssistantStackMode(),
  localStackStopSkippedMessage: () => 'Local mode: leave stack running',
}));

vi.mock('../AssistantStackStore', async () => {
  const actual = await vi.importActual<typeof import('../AssistantStackStore')>(
    '../AssistantStackStore'
  );
  return {
    ...actual,
    getAssistantRootOverride: () => '/tmp/fake-assistant',
    getInstalledAddons: () => installedAddons.ids,
  };
});

const { runCompose, runComposeStreaming, runCli, getContainerRuntime } = fakes;

describe('stopAssistantStack cleanup', () => {
  beforeEach(() => {
    __test.resetModuleStateForTests();
    installedAddons.ids = [];
    isLocalAssistantStackMode.mockReset();
    isLocalAssistantStackMode.mockReturnValue(false);
    runComposeStreaming.mockReset();
    runCompose.mockReset();
    runCli.mockReset();
    getContainerRuntime.mockReset();

    getContainerRuntime.mockResolvedValue(dockerRuntime({ compose: '2' }));

    runComposeStreaming.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    runCompose.mockResolvedValue({ stdout: '[]', stderr: '' });
    runCli.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('stops the containers and keeps them, their volumes and their images', async () => {
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

  it('stop passes --profile crm when Twenty is installed', async () => {
    installedAddons.ids = ['twenty'];
    __test.resetLifecycle();

    await stopAssistantStack();

    const args = runComposeStreaming.mock.calls[0][1] as string[];
    expect(args).toContain('stop');
    expect(args.join(' ')).toContain('--profile crm');
  });

  it('skips compose stop in local-stack mode', async () => {
    isLocalAssistantStackMode.mockReturnValue(true);
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
    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready'));
    announceAssistantStackStopping();
    expect(__test.getLifecycleSnapshot().phase).toBe('ready');
  });

  it('announceAssistantStackStopping sets stopping phase', async () => {
    __test.setLifecycleSnapshot(createLifecycleSnapshot('ready'));
    announceAssistantStackStopping();
    expect(__test.getLifecycleSnapshot().phase).toBe('stopping');
  });
});
