import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runComposeStreaming = vi.fn();
const runCompose = vi.fn();
const clearLlmKeysFromProjectEnv = vi.fn();
const runCli = vi.fn();
const getContainerRuntime = vi.fn();
const ensureSovereignProjectProvisioned = vi.fn();
const runSovereignSetup = vi.fn();
const isHostSetupComplete = vi.fn();
const markHostSetupComplete = vi.fn();
const needsImageBuild = vi.fn();
const markImagesBuilt = vi.fn();
const isBoundaryOwnedAssistantRoot = vi.fn();
const httpOk = vi.fn();

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
    root: '/tmp/boundary-project',
    error: undefined,
  }),
  resolveAssistantRoot: () => '/tmp/boundary-project',
}));

vi.mock('../assistantPaths', () => ({
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantDataRoot: () => '/tmp/boundary-project/data',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  resolveAssistantUserContentRoot: () => '/tmp/boundary-project/data',
  resolveAssistantProjectRoot: () => '/tmp/boundary-project',
  resolveAssistantStackHome: () => '/tmp/assistant-stack-home',
  isBoundaryOwnedAssistantRoot: (...args: unknown[]) => isBoundaryOwnedAssistantRoot(...args),
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
  ensureAssistantDataDirs: async () => undefined,
  ensureAssistantWorkspaceDir: async () => undefined,
  hermesConfigExists: () => true,
  removeIncompleteHermesProfiles: async () => [],
}));

vi.mock('../provisionSovereignStack', () => ({
  ensureSovereignProjectProvisioned: (...args: unknown[]) =>
    ensureSovereignProjectProvisioned(...args),
  isHostSetupComplete: (...args: unknown[]) => isHostSetupComplete(...args),
  markHostSetupComplete: (...args: unknown[]) => markHostSetupComplete(...args),
  needsImageBuild: (...args: unknown[]) => needsImageBuild(...args),
  markImagesBuilt: (...args: unknown[]) => markImagesBuilt(...args),
  resetBoundaryAssistantStack: async () => undefined,
}));

vi.mock('../hermes/hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes/hermesProjectsOverlay')>()),
  hermesProjectsOverlayExists: () => false,
  writeHermesProjectsOverlay: () => '/tmp/assistant-stack-home/docker-compose.projects.yml',
  ensureProjectMountPoints: () => undefined,
}));

vi.mock('../hermesWorkerKey', () => ({
  ensureHermesWorkerKey: async () => false,
}));

vi.mock('../runSovereignSetup', () => ({
  runSovereignSetup: (...args: unknown[]) => runSovereignSetup(...args),
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: async () => undefined,
  clearLlmKeysFromProjectEnv: (...args: unknown[]) => clearLlmKeysFromProjectEnv(...args),
  upsertEnvLine: (contents: string) => contents,
}));

vi.mock('../AssistantStackStore', async () => {
  const actual = await vi.importActual<typeof import('../AssistantStackStore')>(
    '../AssistantStackStore'
  );
  return {
    ...actual,
    getAssistantRootOverride: () => null,
    isAssistantStackSetupComplete: () => false,
  };
});

vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getLlmConnection: () => null,
}));

describe('ensureAssistantStackRunning host setup gating', () => {
  const prevLocal = process.env.BOUNDARY_LOCAL_STACK;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.BOUNDARY_LOCAL_STACK;
    runComposeStreaming.mockReset();
    runCompose.mockReset();
    runCli.mockReset();
    getContainerRuntime.mockReset();
    ensureSovereignProjectProvisioned.mockReset();
    runSovereignSetup.mockReset();
    isHostSetupComplete.mockReset();
    markHostSetupComplete.mockReset();
    isBoundaryOwnedAssistantRoot.mockReset();
    httpOk.mockReset();
    needsImageBuild.mockReset().mockReturnValue(false);
    markImagesBuilt.mockReset().mockResolvedValue(undefined);
    clearLlmKeysFromProjectEnv.mockReset().mockResolvedValue(false);

    getContainerRuntime.mockResolvedValue({
      kind: 'docker',
      origin: 'system',
      cliPath: 'docker',
      composeArgv: ['compose'],
      env: {
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        PATH: '/usr/bin',
      },
      apiEndpoint: 'unix:///var/run/docker.sock',
      version: { cli: '1', compose: '2' },
    });
    runComposeStreaming.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    runCompose.mockResolvedValue({ stdout: '[]', stderr: '' });
    runCli.mockResolvedValue({ stdout: '', stderr: '' });
    ensureSovereignProjectProvisioned.mockResolvedValue('/tmp/boundary-project');
    markHostSetupComplete.mockResolvedValue(undefined);
    isBoundaryOwnedAssistantRoot.mockReturnValue(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
      })) as unknown as typeof fetch
    );
  });

  afterEach(() => {
    if (prevLocal === undefined) {
      delete process.env.BOUNDARY_LOCAL_STACK;
    } else {
      process.env.BOUNDARY_LOCAL_STACK = prevLocal;
    }
  });

  it('runs setup.sh on first ensure when host setup incomplete', async () => {
    isHostSetupComplete.mockReturnValue(false);
    const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
    __test.resetLifecycle();

    const result = await ensureAssistantStackRunning();
    expect(result.success).toBe(true);
    expect(ensureSovereignProjectProvisioned).toHaveBeenCalled();
    expect(runSovereignSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/tmp/boundary-project',
        workspaceRoot: '/tmp/assistant-workspace',
        env: expect.objectContaining({
          DOCKER_HOST: 'unix:///var/run/docker.sock',
        }),
      })
    );
    expect(markHostSetupComplete).toHaveBeenCalled();
  });

  it('skips setup.sh when host setup already complete', async () => {
    isHostSetupComplete.mockReturnValue(true);
    const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
    __test.resetLifecycle();

    const result = await ensureAssistantStackRunning();
    expect(result.success).toBe(true);
    expect(runSovereignSetup).not.toHaveBeenCalled();
    expect(markHostSetupComplete).not.toHaveBeenCalled();
  });

  it('recreates a running proxy once when its key was still in .env', async () => {
    isHostSetupComplete.mockReturnValue(true);
    clearLlmKeysFromProjectEnv.mockResolvedValue(true);
    const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
    __test.resetLifecycle();

    const result = await ensureAssistantStackRunning();
    expect(result.success).toBe(true);
    expect(clearLlmKeysFromProjectEnv).toHaveBeenCalledWith('/tmp/boundary-project');
    const recreate = runCompose.mock.calls.find(([, args]) =>
      (args as string[]).includes('llm-proxy')
    );
    expect(recreate?.[1]).toEqual(expect.arrayContaining(['up', '-d', '--no-deps', 'llm-proxy']));
  });

  it('leaves a running proxy alone when .env had no key', async () => {
    isHostSetupComplete.mockReturnValue(true);
    const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
    __test.resetLifecycle();

    await ensureAssistantStackRunning();
    expect(
      runCompose.mock.calls.some(([, args]) => (args as string[]).includes('llm-proxy'))
    ).toBe(false);
  });

  describe('after a pin change', () => {
    /** The stack is down until compose up runs, then healthy. */
    function stackComesUpOnCompose(): void {
      let up = false;
      runComposeStreaming.mockImplementation(async () => {
        up = true;
        return { stdout: '', stderr: '', code: 0 };
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
    }

    function upArgs(): string[] | undefined {
      const call = runComposeStreaming.mock.calls.find(([, args]) =>
        (args as string[]).includes('up')
      );
      return call?.[1] as string[] | undefined;
    }

    it('rebuilds the local images once', async () => {
      isHostSetupComplete.mockReturnValue(true);
      needsImageBuild.mockReturnValue(true);
      stackComesUpOnCompose();
      const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
      __test.resetLifecycle();

      const result = await ensureAssistantStackRunning();
      expect(result.success).toBe(true);
      expect(upArgs()).toEqual(expect.arrayContaining(['up', '-d', '--build']));
      expect(markImagesBuilt).toHaveBeenCalledTimes(1);
    });

    it('starts without building when the images match the tree', async () => {
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
      __test.resetLifecycle();

      await ensureAssistantStackRunning();
      expect(upArgs()).toBeDefined();
      expect(upArgs()).not.toContain('--build');
      expect(markImagesBuilt).not.toHaveBeenCalled();
    });
  });

  it('shares one in-flight ensure across concurrent callers', async () => {
    isHostSetupComplete.mockReturnValue(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ensureSovereignProjectProvisioned.mockImplementation(async () => {
      await gate;
      return '/tmp/boundary-project';
    });

    const { ensureAssistantStackRunning, ensureAssistantStackRunningInBackground, __test } =
      await import('../AssistantStackService');
    __test.resetLifecycle();

    const first = ensureAssistantStackRunning();
    expect(__test.getEnsureRunningPromise()).toBeTruthy();
    ensureAssistantStackRunningInBackground();
    const second = ensureAssistantStackRunning();

    // tryAttachToLiveLocalStack awaits before provision; wait for the shared ensure to enter it.
    await vi.waitFor(() => {
      expect(ensureSovereignProjectProvisioned).toHaveBeenCalledTimes(1);
    });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(__test.getEnsureRunningPromise()).toBeNull();
  });
});
