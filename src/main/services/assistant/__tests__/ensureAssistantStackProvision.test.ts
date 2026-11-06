import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStackLifecycleSnapshot } from '../../../../shared/types/assistantStack';

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
const removeIncompleteHermesProfiles = vi.fn();
const writeProjectsOverlay = vi.fn();
const n8n = vi.hoisted(() => ({ enabled: false }));
/** The stored LightRAG setting; undefined until something writes it. */
const rag = vi.hoisted(() => ({ setting: undefined as boolean | undefined }));
const ragStore = vi.hoisted(() => ({
  isLightragEnabled: () => rag.setting === true,
  isLightragSettingUnset: () => rag.setting === undefined,
  setLightragEnabled: (enabled: boolean) => {
    rag.setting = enabled;
  },
}));
/** What `config --services` lists for Boundary's profiles in these tests. */
const COMPOSE_SERVICES = ['hermes', 'gpt-researcher', 'gptr-mcp', 'n8n-import', 'n8n'];

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
  resolveActiveAssistantRoot: () => '/tmp/boundary-project',
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
  removeIncompleteHermesProfiles: (...args: unknown[]) => removeIncompleteHermesProfiles(...args),
}));

vi.mock('../provisionSovereignStack', () => ({
  ensureSovereignProjectProvisioned: (...args: unknown[]) =>
    ensureSovereignProjectProvisioned(...args),
  isHostSetupComplete: (...args: unknown[]) => isHostSetupComplete(...args),
  markHostSetupComplete: (...args: unknown[]) => markHostSetupComplete(...args),
  needsImageBuild: (...args: unknown[]) => needsImageBuild(...args),
  markImagesBuilt: (...args: unknown[]) => markImagesBuilt(...args),
}));

vi.mock('../hermes/hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes/hermesProjectsOverlay')>()),
  hermesProjectsOverlayExists: () => false,
  writeHermesProjectsOverlay: (...args: unknown[]) => writeProjectsOverlay(...args),
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
}));

vi.mock('../AssistantStackStore', async () => {
  const actual = await vi.importActual<typeof import('../AssistantStackStore')>(
    '../AssistantStackStore'
  );
  return {
    ...actual,
    getAssistantRootOverride: () => null,
    isAssistantStackSetupComplete: () => false,
    isN8nEnabled: () => n8n.enabled,
    ...ragStore,
  };
});

vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getLlmConnection: () => null,
  getAppSharedModel: () => null,
}));

describe('ensureAssistantStackRunning host setup gating', () => {
  const prevLocal = process.env.BOUNDARY_LOCAL_STACK;
  const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.BOUNDARY_LOCAL_STACK;
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    removeIncompleteHermesProfiles.mockReset().mockResolvedValue([]);
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
    writeProjectsOverlay
      .mockReset()
      .mockReturnValue('/tmp/assistant-stack-home/docker-compose.projects.yml');

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
    n8n.enabled = false;
    rag.setting = false;
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => ({
      stdout: args.includes('config') ? `${COMPOSE_SERVICES.join('\n')}\n` : '[]',
      stderr: '',
    }));
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
    if (prevRoot === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
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

  it('still starts on launch when finished setup has no provider left', async () => {
    isHostSetupComplete.mockReturnValue(true);
    vi.doMock('../AssistantStackStore', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../AssistantStackStore')>()),
      isAssistantStackSetupComplete: () => true,
    }));
    const { ensureAssistantStackOnLaunch, getAssistantStackLifecycle, __test } = await import(
      '../AssistantStackService'
    );
    __test.resetLifecycle();

    await ensureAssistantStackOnLaunch();
    vi.doUnmock('../AssistantStackStore');
    expect(getAssistantStackLifecycle().phase).toBe('ready');
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

  describe('stub gateway profiles', () => {
    /** The stack is down until compose up runs, then healthy. */
    function stackComesUpOnCompose(): void {
      let up = false;
      runComposeStreaming.mockImplementation(async () => {
        up = true;
        return { stdout: '', stderr: '', code: 0 };
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
    }

    it('are cleaned up before up on the managed install', async () => {
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
      __test.resetLifecycle();

      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(removeIncompleteHermesProfiles).toHaveBeenCalledWith('/tmp/boundary-project/data');
    });

    it('are left alone in a local checkout that Boundary starts itself', async () => {
      process.env.BOUNDARY_ASSISTANT_ROOT = '/tmp/dev-assistant-checkout';
      isHostSetupComplete.mockReturnValue(true);
      isBoundaryOwnedAssistantRoot.mockReturnValue(false);
      stackComesUpOnCompose();
      const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
      __test.resetLifecycle();

      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(runComposeStreaming).toHaveBeenCalled();
      expect(removeIncompleteHermesProfiles).not.toHaveBeenCalled();
    });
  });

  describe('start timing', () => {
    /** One `compose up` that reports the bootstraps and Hermes, then a healthy stack. */
    function composeReportsMilestones(): void {
      let up = false;
      runComposeStreaming.mockImplementation(async (_runtime, args, options) => {
        if ((args as string[]).includes('up')) {
          for (const [id, text] of [
            ['Container boundary-assistant-hermes-api-bootstrap-1', 'Started'],
            ['Container boundary-assistant-hermes-api-bootstrap-1', 'Exited'],
            ['Container boundary-assistant-hermes-browser-bootstrap-1', 'Exited'],
            ['Container boundary-hermes', 'Started'],
          ]) {
            options.onStdoutLine(JSON.stringify({ id, text }));
          }
        }
        up = true;
        return { stdout: '', stderr: '', code: 0 };
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
    }

    it('gives the next start of that kind the finished run to go by', async () => {
      isHostSetupComplete.mockReturnValue(true);
      composeReportsMilestones();
      runCli.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });
      const {
        ensureAssistantStackRunning,
        getAssistantStackLifecycle,
        setAssistantStackLifecycleCallback,
        __test,
      } = await import('../AssistantStackService');
      __test.resetLifecycle();
      const seen: AssistantStackLifecycleSnapshot[] = [];
      setAssistantStackLifecycleCallback((snapshot) => seen.push(snapshot));

      expect((await ensureAssistantStackRunning()).success).toBe(true);
      const during = seen.filter((snapshot) => snapshot.startTiming).at(-1)?.startTiming;
      expect(during).toMatchObject({ kind: 'relaunch', fromHistory: false });
      expect(Object.keys(during?.reached ?? {})).toEqual(
        expect.arrayContaining(['prepared', 'apiBootstrapDone', 'browserBootstrapDone', 'hermesStarted'])
      );
      expect(getAssistantStackLifecycle().startTiming).toBeUndefined();

      seen.length = 0;
      vi.mocked(fetch).mockImplementation(async () => ({ ok: false }) as Response);
      composeReportsMilestones();
      await ensureAssistantStackRunning();
      const next = seen.find((snapshot) => snapshot.startTiming)?.startTiming;
      expect(next).toMatchObject({ kind: 'relaunch', fromHistory: true });
    });

    it('counts a start with no containers as new containers', async () => {
      isHostSetupComplete.mockReturnValue(true);
      composeReportsMilestones();
      runCli.mockResolvedValue({ stdout: '', stderr: '' });
      const { ensureAssistantStackRunning, setAssistantStackLifecycleCallback, __test } =
        await import('../AssistantStackService');
      __test.resetLifecycle();
      const seen: AssistantStackLifecycleSnapshot[] = [];
      setAssistantStackLifecycleCallback((snapshot) => seen.push(snapshot));

      await ensureAssistantStackRunning();
      expect(seen.some((snapshot) => snapshot.startTiming?.kind === 'newContainers')).toBe(true);
    });
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

    it('start passes --profile crm when Twenty is installed', async () => {
      const { setAddonInstalled } = await import('../AssistantStackStore');
      const root = '/tmp/boundary-project';
      setAddonInstalled(root, 'twenty', true);
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
      __test.resetLifecycle();

      try {
        await ensureAssistantStackRunning();
        expect((upArgs() ?? []).join(' ')).toContain('--profile crm');
        const env = runComposeStreaming.mock.calls.find(([, args]) =>
          (args as string[]).includes('up')
        )?.[2]?.env as Record<string, string>;
        expect(env.TWENTY_LOCAL_ENABLED).toBe('1');
        expect(env.TWENTY_MCP_ENABLED).toBe('1');
        expect(env.COMPOSE_PROFILES.split(',')).toContain('crm');
      } finally {
        setAddonInstalled(root, 'twenty', false);
      }
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

  describe('n8n', () => {
    function upArgs(): string[] {
      const call = runComposeStreaming.mock.calls.find(([, args]) =>
        (args as string[]).includes('up')
      );
      expect(call).toBeDefined();
      return call![1] as string[];
    }

    async function start(): Promise<void> {
      // An earlier test's doUnmock drops the file-level store mock, so register it here.
      vi.doMock('../AssistantStackStore', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../AssistantStackStore')>()),
        getAssistantRootOverride: () => null,
        isAssistantStackSetupComplete: () => false,
        isN8nEnabled: () => n8n.enabled,
        ...ragStore,
      }));
      isHostSetupComplete.mockReturnValue(true);
      let up = false;
      runComposeStreaming.mockImplementation(async () => {
        up = true;
        return { stdout: '', stderr: '', code: 0 };
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
      const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
      __test.resetLifecycle();
      expect((await ensureAssistantStackRunning()).success).toBe(true);
    }

    it('names every service but n8n’s when n8n is off, keeping the automation profile', async () => {
      await start();
      const args = upArgs();
      expect(args).toEqual(expect.arrayContaining(['--profile', 'automation']));
      expect(args.slice(args.indexOf('-d') + 1)).toEqual(['hermes', 'gptr-mcp']);
    });

    it('lists services with the crm profile when Twenty is installed and n8n is off', async () => {
      const { setAddonInstalled } = await import('../AssistantStackStore');
      const root = '/tmp/boundary-project';
      setAddonInstalled(root, 'twenty', true);
      try {
        await start();
        const config = runCompose.mock.calls.find(([, a]) => (a as string[]).includes('config'));
        expect((config?.[1] as string[]).join(' ')).toContain('--profile crm');
        expect(upArgs().join(' ')).toContain('--profile crm');
      } finally {
        setAddonInstalled(root, 'twenty', false);
      }
    });

    it('names no services when n8n is on, so `up` starts the whole profiles', async () => {
      n8n.enabled = true;
      await start();
      const args = upArgs();
      expect(args[args.length - 1]).toBe('-d');
      expect(runCompose.mock.calls.some(([, a]) => (a as string[]).includes('config'))).toBe(false);
    });

    it('leaves n8n and the GPT Researcher API off the start-up cards while n8n is off', async () => {
      const { setAssistantStackLifecycleCallback } = await import('../AssistantStackService');
      const seen: AssistantStackLifecycleSnapshot[] = [];
      setAssistantStackLifecycleCallback((snapshot) => seen.push(snapshot));
      await start();
      const names = seen.flatMap((snapshot) => snapshot.services.map((s) => s.containerName));
      expect(names).toContain('boundary-hermes');
      expect(names).toContain('boundary-gptr-mcp');
      expect(names).not.toContain('boundary-n8n');
      expect(names).not.toContain('boundary-gpt-researcher');
    });
  });

  describe('LightRAG', () => {
    function upCall(): { args: string[]; env: NodeJS.ProcessEnv } {
      const call = runComposeStreaming.mock.calls.find(([, args]) =>
        (args as string[]).includes('up')
      );
      expect(call).toBeDefined();
      return { args: call![1] as string[], env: (call![2] as { env: NodeJS.ProcessEnv }).env };
    }

    function removals(): string[][] {
      return runCompose.mock.calls
        .map(([, args]) => args as string[])
        .filter((args) => args.includes('rm'));
    }

    async function start(): Promise<AssistantStackLifecycleSnapshot[]> {
      vi.doMock('../AssistantStackStore', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../AssistantStackStore')>()),
        getAssistantRootOverride: () => null,
        isAssistantStackSetupComplete: () => false,
        isN8nEnabled: () => n8n.enabled,
        ...ragStore,
      }));
      isHostSetupComplete.mockReturnValue(true);
      let up = false;
      runComposeStreaming.mockImplementation(async () => {
        up = true;
        return { stdout: '', stderr: '', code: 0 };
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
      const { ensureAssistantStackRunning, setAssistantStackLifecycleCallback, __test } =
        await import('../AssistantStackService');
      __test.resetLifecycle();
      const seen: AssistantStackLifecycleSnapshot[] = [];
      setAssistantStackLifecycleCallback((snapshot) => seen.push(snapshot));
      expect((await ensureAssistantStackRunning()).success).toBe(true);
      return seen;
    }

    it('removes the rag containers once on the first start with no setting, then records off', async () => {
      rag.setting = undefined;
      await start();
      const [rm, ...more] = removals();
      expect(more).toEqual([]);
      expect(rm.join(' ')).toContain('--profile rag');
      expect(rm.slice(rm.indexOf('rm'))).toEqual(['rm', '-sf', 'lightrag-mcp', 'lightrag', 'neo4j']);
      expect(rag.setting).toBe(false);

      runCompose.mockClear();
      runComposeStreaming.mockClear();
      await start();
      expect(removals()).toEqual([]);
    });

    it('still starts and tries again next time when the removal fails', async () => {
      rag.setting = undefined;
      runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => {
        if (args.includes('rm')) throw new Error('engine went away');
        return { stdout: args.includes('config') ? `${COMPOSE_SERVICES.join('\n')}\n` : '[]', stderr: '' };
      });
      await start();
      expect(rag.setting).toBeUndefined();
    });

    it('starts without the rag profile, with Hermes told LightRAG is off', async () => {
      const seen = await start();
      const { args, env } = upCall();
      expect(args.join(' ')).not.toContain('--profile rag');
      expect(env.COMPOSE_PROFILES?.split(',')).not.toContain('rag');
      expect(env.LIGHTRAG_MCP_ENABLED).toBe('0');
      expect(removals()).toEqual([]);
      const names = seen.flatMap((snapshot) => snapshot.services.map((s) => s.containerName));
      expect(names).not.toContain('boundary-lightrag');
      expect(names).not.toContain('boundary-lightrag-neo4j');
    });

    it('starts the rag profile, with Hermes told to register LightRAG, while it is on', async () => {
      rag.setting = true;
      const seen = await start();
      const { args, env } = upCall();
      expect(args).toEqual(expect.arrayContaining(['--profile', 'rag']));
      expect(env.COMPOSE_PROFILES?.split(',')).toContain('rag');
      expect(env.LIGHTRAG_MCP_ENABLED).toBe('1');
      const names = seen.flatMap((snapshot) => snapshot.services.map((s) => s.containerName));
      expect(names).toContain('boundary-lightrag');
      expect(names).toContain('boundary-lightrag-neo4j');
    });
  });

  it('writes the projects overlay and runs `up` in the folder remount queue', async () => {
    isHostSetupComplete.mockReturnValue(true);
    const events: string[] = [];
    let up = false;
    runComposeStreaming.mockImplementation(async () => {
      events.push('up');
      up = true;
      return { stdout: '', stderr: '', code: 0 };
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
    writeProjectsOverlay.mockImplementation(() => {
      events.push('overlay');
      return '/tmp/assistant-stack-home/docker-compose.projects.yml';
    });
    const { ensureAssistantStackRunning, __test } = await import('../AssistantStackService');
    const { enqueueFolderRemount } = await import('../hermes/projectMountState');
    __test.resetLifecycle();

    let releaseRemount: () => void = () => undefined;
    const before = enqueueFolderRemount(async () => {
      await new Promise<void>((resolve) => (releaseRemount = resolve));
      events.push('remount before');
      return { success: true };
    });
    const start = ensureAssistantStackRunning();
    await vi.waitFor(() => expect(ensureSovereignProjectProvisioned).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);
    const after = enqueueFolderRemount(async () => {
      events.push('remount after');
      return { success: true };
    });
    releaseRemount();
    await Promise.all([start, before, after]);
    expect(events).toEqual(['remount before', 'overlay', 'up', 'remount after']);
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
