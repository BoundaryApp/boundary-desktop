import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __test,
  ensureAssistantStackAndApplyLlm,
  ensureAssistantStackOnLaunch,
  ensureAssistantStackRunning,
  ensureAssistantStackRunningInBackground,
  getAssistantStackLifecycle,
  setAssistantStackLifecycleCallback,
} from '../AssistantStackService';
import { setAddonInstalled } from '../AssistantStackStore';
import {
  enqueueFolderRemount,
  resetFolderRemountQueueForTests,
  resetMountedProjectFoldersForTests,
} from '../hermes/projectMountState';
import { __resetLlmProxyKeeperForTests } from '../llmProxyKeyKeeper';
import { resetStackModeCacheForTests } from '../localStackMode';
import { onBeforeStackUp, onHermesReplaced } from '../hermesLifecycle';
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
const ensureAddonMountSources = vi.fn(async (_root: string) => {});
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
/** The n8n and LightRAG flags in the stack's `.env`, and the calls that wrote the old switches there. */
const builtin = vi.hoisted(() => ({
  n8n: false,
  lightrag: false,
  moves: [] as Array<{ root: string; stored: Record<string, boolean> }>,
}));

vi.mock('../../addons/builtinAddons', async () => {
  const actual = await vi.importActual<typeof import('../../addons/builtinAddons')>('../../addons/builtinAddons');
  return {
    ...actual,
    builtinAddonAvailable: () => true,
    readBuiltinEnabled: (_root: string, id: 'n8n' | 'lightrag') => builtin[id],
    moveBuiltinSwitchesToEnv: async (_files: unknown, root: string, deps: { stored(): Record<string, boolean> }) => {
      builtin.moves.push({ root, stored: deps.stored() });
      return {};
    },
  };
});

/** Calls that carried Twenty's flags into the stack's `.env`, with the installed state they read. */
const twentyMoves = vi.hoisted(() => [] as Array<{ root: string; installed: boolean }>);

vi.mock('../../addons/addonComposeState', async () => {
  const actual = await vi.importActual<typeof import('../../addons/addonComposeState')>('../../addons/addonComposeState');
  return {
    ...actual,
    moveTwentyFlagsToEnv: async (_files: unknown, root: string, deps: { installed(root: string): boolean }) => {
      twentyMoves.push({ root, installed: deps.installed(root) });
      return {};
    },
  };
});

/** Store answers single tests change; beforeEach puts them back. */
const storeOverrides = vi.hoisted(() => ({
  setupComplete: false,
  /** Stands in for markAssistantStackSetupComplete when set. */
  markSetupComplete: undefined as (() => void) | undefined,
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
    error: undefined as string | undefined,
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
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
  ensureAssistantDataDirs: async () => {},
  ensureAddonMountSources: (root: string) => ensureAddonMountSources(root),
  ensureAssistantWorkspaceDir: async () => {},
  hermesConfigExists: () => true,
  removeIncompleteHermesProfiles: (...args: unknown[]) => removeIncompleteHermesProfiles(...args),
}));

const caps = vi.hoisted(() => ({ provision: true }));
vi.mock('../../stackHost/capabilities', async () =>
  (await import('../../stackHost/fakeStackHost')).fakeCapabilitiesModule(() => ({
    hostFolders: true,
    hostCallbacks: true,
    provision: caps.provision,
    engineControl: true,
  }))
);

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
  ensureProjectMountPoints: () => {},
}));

vi.mock('../hermesWorkerKey', () => ({
  ensureHermesWorkerKey: async () => false,
}));

vi.mock('../runSovereignSetup', () => ({
  runSovereignSetup: (...args: unknown[]) => runSovereignSetup(...args),
}));

vi.mock('../applyLlmToProjectEnv', () => ({
  applyLlmConnectionToProjectFiles: async () => {},
  clearLlmKeysFromProjectEnv: (...args: unknown[]) => clearLlmKeysFromProjectEnv(...args),
}));

vi.mock('../AssistantStackStore', async () => {
  const actual = await vi.importActual<typeof import('../AssistantStackStore')>(
    '../AssistantStackStore'
  );
  return {
    ...actual,
    getAssistantRootOverride: (): null => null,
    isAssistantStackSetupComplete: () => storeOverrides.setupComplete,
    markAssistantStackSetupComplete: () =>
      (storeOverrides.markSetupComplete ?? actual.markAssistantStackSetupComplete)(),
    isN8nEnabled: () => n8n.enabled,
    ...ragStore,
  };
});

vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getLlmConnection: (): null => null,
}));
vi.mock('../../inference/appInferenceChoice', () => ({
  getAppSharedModel: (): null => null,
}));

type StreamingOptions = { env?: NodeJS.ProcessEnv; onStdoutLine: (line: string) => void };

/**
 * The stack is down until compose up runs, then healthy. `onCompose` runs first on each
 * streamed compose call, to record or report output.
 */
function stackComesUpOnCompose(onCompose?: (args: string[], options: StreamingOptions) => void): void {
  let up = false;
  runComposeStreaming.mockImplementation(async (_runtime, args, options) => {
    onCompose?.(args as string[], options as StreamingOptions);
    up = true;
    return { stdout: '', stderr: '', code: 0 };
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
}

/** The one streamed `up` of the start: `up -d` on Boundary's project with JSON progress. */
function upCall(): { args: string[]; env: NodeJS.ProcessEnv } {
  const ups = runComposeStreaming.mock.calls.filter(([, args]) => (args as string[]).includes('up'));
  expect(ups).toHaveLength(1);
  const args = ups[0][1] as string[];
  expect(args.slice(0, 2)).toEqual(['--progress', 'json']);
  expect(args.slice(args.indexOf('up'), args.indexOf('up') + 2)).toEqual(['up', '-d']);
  return { args, env: (ups[0][2] as StreamingOptions).env ?? {} };
}

describe('ensureAssistantStackRunning host setup gating', () => {
  beforeEach(() => {
    __test.resetModuleStateForTests();
    resetStackModeCacheForTests();
    resetMountedProjectFoldersForTests();
    resetFolderRemountQueueForTests();
    __resetLlmProxyKeeperForTests();
    storeOverrides.setupComplete = false;
    storeOverrides.markSetupComplete = undefined;
    vi.stubEnv('BOUNDARY_LOCAL_STACK', undefined);
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    removeIncompleteHermesProfiles.mockReset().mockResolvedValue([]);
    runComposeStreaming.mockReset();
    runCompose.mockReset();
    runCli.mockReset();
    getContainerRuntime.mockReset();
    ensureSovereignProjectProvisioned.mockReset();
    runSovereignSetup.mockReset();
    isHostSetupComplete.mockReset();
    markHostSetupComplete.mockReset();
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
    builtin.n8n = false;
    builtin.lightrag = false;
    builtin.moves = [];
    twentyMoves.length = 0;
    runCompose.mockImplementation(async (_runtime: unknown, args: string[]) => ({
      stdout: args.includes('config') ? `${COMPOSE_SERVICES.join('\n')}\n` : '[]',
      stderr: '',
    }));
    runCli.mockResolvedValue({ stdout: '', stderr: '' });
    ensureSovereignProjectProvisioned.mockResolvedValue('/tmp/boundary-project');
    markHostSetupComplete.mockResolvedValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
      })) as unknown as typeof fetch
    );
  });

  it('runs setup.sh on first ensure when host setup incomplete', async () => {
    isHostSetupComplete.mockReturnValue(false);
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

  it('creates the add-on folders the core bootstraps mount before up', async () => {
    // Stack v0.3.13's hermes bootstraps bind-mount data/addons/{twenty,actual/instances}, and
    // Podman refuses a missing source.
    isHostSetupComplete.mockReturnValue(true);
    stackComesUpOnCompose();
    __test.resetLifecycle();

    const result = await ensureAssistantStackRunning();
    expect(result.success).toBe(true);
    expect(ensureAddonMountSources).toHaveBeenCalledWith('/tmp/boundary-project/data');
    upCall();
    const up = runComposeStreaming.mock.invocationCallOrder.find(
      (_order, i) => (runComposeStreaming.mock.calls[i][1] as string[]).includes('up')
    );
    expect(ensureAddonMountSources.mock.invocationCallOrder[0]).toBeLessThan(up ?? 0);
  });

  it('neither provisions nor runs setup.sh on a host without provision, and still starts', async () => {
    caps.provision = false;
    try {
      isHostSetupComplete.mockReturnValue(false);
      __test.resetLifecycle();

      const result = await ensureAssistantStackRunning();
      expect(result.success).toBe(true);
      expect(ensureSovereignProjectProvisioned).not.toHaveBeenCalled();
      expect(runSovereignSetup).not.toHaveBeenCalled();
      expect(markHostSetupComplete).not.toHaveBeenCalled();
    } finally {
      caps.provision = true;
    }
  });

  it('skips setup.sh when host setup already complete', async () => {
    isHostSetupComplete.mockReturnValue(true);
    __test.resetLifecycle();

    const result = await ensureAssistantStackRunning();
    expect(result.success).toBe(true);
    expect(runSovereignSetup).not.toHaveBeenCalled();
    expect(markHostSetupComplete).not.toHaveBeenCalled();
  });

  it('notifies start once, after `up` and the health check', async () => {
    isHostSetupComplete.mockReturnValue(true);
    stackComesUpOnCompose();
    __test.resetLifecycle();
    const replaced = vi.fn(() => expect(runComposeStreaming).toHaveBeenCalled());
    const off = onHermesReplaced(replaced);
    try {
      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(replaced.mock.calls).toEqual([['start']]);
    } finally {
      off();
    }
  });

  it('runs the before-up listeners before `up`', async () => {
    isHostSetupComplete.mockReturnValue(true);
    stackComesUpOnCompose();
    __test.resetLifecycle();
    const beforeUp = vi.fn(async () => {
      expect(runComposeStreaming).not.toHaveBeenCalled();
    });
    const off = onBeforeStackUp(beforeUp);
    try {
      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(beforeUp).toHaveBeenCalledTimes(1);
      expect(beforeUp.mock.invocationCallOrder[0]).toBeLessThan(runComposeStreaming.mock.invocationCallOrder[0]);
    } finally {
      off();
    }
  });

  it('fails the start with the message of a before-up listener, without running `up`', async () => {
    isHostSetupComplete.mockReturnValue(true);
    stackComesUpOnCompose();
    __test.resetLifecycle();
    const off = onBeforeStackUp(async () => {
      throw new Error('Bitwarden’s folders couldn’t be created (vault.sh pre-up exited 2).');
    });
    try {
      const result = await ensureAssistantStackRunning();
      expect(result.success).toBe(false);
      expect(result.error).toContain('vault.sh pre-up exited 2');
      expect(runComposeStreaming).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('notifies nothing when the stack was already running', async () => {
    isHostSetupComplete.mockReturnValue(true);
    __test.resetLifecycle();
    const replaced = vi.fn();
    const off = onHermesReplaced(replaced);
    try {
      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(runComposeStreaming).not.toHaveBeenCalled();
      expect(replaced).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('notifies nobody when `up` fails', async () => {
    isHostSetupComplete.mockReturnValue(true);
    stackComesUpOnCompose();
    runComposeStreaming.mockRejectedValue(new Error('up failed'));
    __test.resetLifecycle();
    const replaced = vi.fn();
    const off = onHermesReplaced(replaced);
    try {
      expect((await ensureAssistantStackRunning()).success).toBe(false);
      expect(replaced).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('still starts when a listener rejects', async () => {
    isHostSetupComplete.mockReturnValue(true);
    stackComesUpOnCompose();
    __test.resetLifecycle();
    const off = onHermesReplaced(() => Promise.reject(new Error('follow failed')));
    try {
      expect((await ensureAssistantStackRunning()).success).toBe(true);
      await Promise.resolve();
    } finally {
      off();
    }
  });

  it('still starts on launch when finished setup has no provider left', async () => {
    isHostSetupComplete.mockReturnValue(true);
    storeOverrides.setupComplete = true;
    __test.resetLifecycle();

    await ensureAssistantStackOnLaunch();
    expect(getAssistantStackLifecycle().phase).toBe('ready');
  });

  it('finishes setup with no model connected, without applying one', async () => {
    isHostSetupComplete.mockReturnValue(true);
    const markComplete = vi.fn();
    storeOverrides.markSetupComplete = markComplete;
    __test.resetLifecycle();

    const result = await ensureAssistantStackAndApplyLlm();
    expect(result.success).toBe(true);
    expect(result.status.ready).toBe(true);
    expect(markComplete).toHaveBeenCalledTimes(1);
  });

  it('recreates a running proxy once when its key was still in .env', async () => {
    isHostSetupComplete.mockReturnValue(true);
    clearLlmKeysFromProjectEnv.mockResolvedValue(true);
    __test.resetLifecycle();

    const result = await ensureAssistantStackRunning();
    expect(result.success).toBe(true);
    expect(clearLlmKeysFromProjectEnv).toHaveBeenCalledTimes(1);
    const recreate = runCompose.mock.calls.find(([, args]) =>
      (args as string[]).includes('llm-proxy')
    );
    expect(recreate?.[1]).toEqual(expect.arrayContaining(['up', '-d', '--no-deps', 'llm-proxy']));
  });

  it('leaves a running proxy alone when .env had no key', async () => {
    isHostSetupComplete.mockReturnValue(true);
    __test.resetLifecycle();

    await ensureAssistantStackRunning();
    expect(
      runCompose.mock.calls.some(([, args]) => (args as string[]).includes('llm-proxy'))
    ).toBe(false);
  });

  describe('stub gateway profiles', () => {
    it('are cleaned up before up on the managed install', async () => {
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      __test.resetLifecycle();

      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(removeIncompleteHermesProfiles).toHaveBeenCalledWith('/tmp/boundary-project/data');
    });

    it('are left alone in a local checkout that Boundary starts itself', async () => {
      vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', '/tmp/dev-assistant-checkout');
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      __test.resetLifecycle();

      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(runComposeStreaming).toHaveBeenCalled();
      expect(removeIncompleteHermesProfiles).not.toHaveBeenCalled();
    });
  });

  describe('start timing', () => {
    /** One `compose up` that reports the bootstraps and Hermes, then a healthy stack. */
    function composeReportsMilestones(): void {
      stackComesUpOnCompose((args, options) => {
        if (!args.includes('up')) return;
        for (const [id, text] of [
          ['Container boundary-assistant-hermes-api-bootstrap-1', 'Started'],
          ['Container boundary-assistant-hermes-api-bootstrap-1', 'Exited'],
          ['Container boundary-assistant-hermes-browser-bootstrap-1', 'Exited'],
          ['Container boundary-hermes', 'Started'],
        ]) {
          options.onStdoutLine(JSON.stringify({ id, text }));
        }
      });
    }

    it('gives the next start of that kind the finished run to go by', async () => {
      isHostSetupComplete.mockReturnValue(true);
      composeReportsMilestones();
      runCli.mockResolvedValue({ stdout: 'abc123\n', stderr: '' });
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
      __test.resetLifecycle();
      const seen: AssistantStackLifecycleSnapshot[] = [];
      setAssistantStackLifecycleCallback((snapshot) => seen.push(snapshot));

      await ensureAssistantStackRunning();
      expect(seen.some((snapshot) => snapshot.startTiming?.kind === 'newContainers')).toBe(true);
    });
  });

  describe('after a pin change', () => {
    it('rebuilds the local images once', async () => {
      isHostSetupComplete.mockReturnValue(true);
      needsImageBuild.mockReturnValue(true);
      stackComesUpOnCompose();
      __test.resetLifecycle();

      const result = await ensureAssistantStackRunning();
      expect(result.success).toBe(true);
      expect(upCall().args).toEqual(expect.arrayContaining(['up', '-d', '--build']));
      expect(markImagesBuilt).toHaveBeenCalledTimes(1);
    });

    it('starts without building when the images match the tree', async () => {
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      __test.resetLifecycle();

      await ensureAssistantStackRunning();
      expect(upCall().args).not.toContain('--build');
      expect(markImagesBuilt).not.toHaveBeenCalled();
    });
  });

  describe('stopped containers on a removed network', () => {
    const STALE =
      '{"error":true,"message":"Error response from daemon: failed to set up container networking: network 8f4ecf11f50ba8608930cc882c4f9ec0c479a917c6335eb9a4c63be0c492d80a not found"}';
    const ups = () =>
      runComposeStreaming.mock.calls
        .map(([, args]) => args as string[])
        .filter((args) => args.includes('up'));

    it('recreates them once and starts', async () => {
      isHostSetupComplete.mockReturnValue(true);
      let up = false;
      runComposeStreaming.mockImplementation(async (_runtime, args: string[]) => {
        if (!args.includes('up')) return { stdout: '', stderr: '', code: 0 };
        if (!args.includes('--force-recreate')) return { stdout: '', stderr: STALE, code: 1 };
        up = true;
        return { stdout: '', stderr: '', code: 0 };
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: up })) as unknown as typeof fetch);
      __test.resetLifecycle();

      expect((await ensureAssistantStackRunning()).success).toBe(true);
      expect(ups()).toHaveLength(2);
      expect(ups()[0]).not.toContain('--force-recreate');
      expect(ups()[1]).toEqual(expect.arrayContaining(['up', '-d', '--force-recreate']));
    });

    it('reports the error when recreating fails too', async () => {
      isHostSetupComplete.mockReturnValue(true);
      runComposeStreaming.mockImplementation(async (_runtime, args: string[]) =>
        args.includes('up') ? { stdout: '', stderr: STALE, code: 1 } : { stdout: '', stderr: '', code: 0 }
      );
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
      __test.resetLifecycle();

      const result = await ensureAssistantStackRunning();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/network [0-9a-f]+ not found/);
      expect(ups()).toHaveLength(2);
    });
  });

  describe('n8n', () => {
    const upArgs = () => upCall().args;

    async function start(): Promise<void> {
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
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

    it('names no services when the n8n add-on is on, so `up` starts the whole profiles', async () => {
      builtin.n8n = true;
      await start();
      const args = upArgs();
      expect(args[args.length - 1]).toBe('-d');
      expect(runCompose.mock.calls.some(([, a]) => (a as string[]).includes('config'))).toBe(false);
    });

    it('writes the old switches into the stack’s .env before `up`', async () => {
      n8n.enabled = true;
      rag.setting = false;
      await start();
      expect(builtin.moves).toEqual([{ root: '/tmp/boundary-project', stored: { n8n: true, lightrag: false } }]);
    });

    it('leaves the .env alone for a stack Boundary doesn’t own', async () => {
      vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', '/tmp/dev-assistant-checkout');
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      __test.resetLifecycle();
      await ensureAssistantStackRunning();
      expect(builtin.moves).toEqual([]);
      expect(twentyMoves).toEqual([]);
    });

    it('leaves n8n and the GPT Researcher API off the start-up cards while n8n is off', async () => {
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
    function removals(): string[][] {
      return runCompose.mock.calls
        .map(([, args]) => args as string[])
        .filter((args) => args.includes('rm'));
    }

    async function start(): Promise<AssistantStackLifecycleSnapshot[]> {
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
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

    it('starts without the rag profile while the add-on is off, leaving its flag to the .env', async () => {
      const seen = await start();
      const { args, env } = upCall();
      expect(args.join(' ')).not.toContain('--profile rag');
      expect(env.COMPOSE_PROFILES?.split(',')).not.toContain('rag');
      expect(env.LIGHTRAG_MCP_ENABLED).toBeUndefined();
      expect(removals()).toEqual([]);
      const names = seen.flatMap((snapshot) => snapshot.services.map((s) => s.containerName));
      expect(names).not.toContain('boundary-lightrag');
      expect(names).not.toContain('boundary-lightrag-neo4j');
    });

    it('starts the rag profile while the add-on is on', async () => {
      builtin.lightrag = true;
      const seen = await start();
      const { args, env } = upCall();
      expect(args).toEqual(expect.arrayContaining(['--profile', 'rag']));
      expect(env.COMPOSE_PROFILES?.split(',')).toContain('rag');
      expect(env.LIGHTRAG_MCP_ENABLED).toBeUndefined();
      const names = seen.flatMap((snapshot) => snapshot.services.map((s) => s.containerName));
      expect(names).toContain('boundary-lightrag');
      expect(names).toContain('boundary-lightrag-neo4j');
    });
  });

  describe('Twenty', () => {
    it('start passes --profile crm when Twenty is installed', async () => {
      const root = '/tmp/boundary-project';
      setAddonInstalled(root, 'twenty', true);
      isHostSetupComplete.mockReturnValue(true);
      stackComesUpOnCompose();
      __test.resetLifecycle();

      try {
        await ensureAssistantStackRunning();
        const { args, env } = upCall();
        expect(args.join(' ')).toContain('--profile crm');
        // The flags come from the stack's .env, which the move below writes before `up`.
        expect(env.TWENTY_LOCAL_ENABLED).toBeUndefined();
        expect(env.TWENTY_MCP_ENABLED).toBeUndefined();
        expect(env.COMPOSE_PROFILES?.split(',')).toContain('crm');
        expect(twentyMoves).toEqual([{ root, installed: true }]);
      } finally {
        setAddonInstalled(root, 'twenty', false);
      }
    });
  });

  it('writes the projects overlay and runs `up` in the folder remount queue', async () => {
    isHostSetupComplete.mockReturnValue(true);
    const events: string[] = [];
    stackComesUpOnCompose(() => events.push('up'));
    writeProjectsOverlay.mockImplementation(() => {
      events.push('overlay');
      return '/tmp/assistant-stack-home/docker-compose.projects.yml';
    });
    __test.resetLifecycle();

    let releaseRemount: () => void = () => undefined;
    const before = enqueueFolderRemount(async () => {
      await new Promise<void>((resolve) => (releaseRemount = resolve));
      events.push('remount before');
      return { success: true };
    });
    const start = ensureAssistantStackRunning();
    await vi.waitFor(() => expect(ensureSovereignProjectProvisioned).toHaveBeenCalled());
    // Give the ensure a full event-loop turn to run ahead of the queue if it were going to.
    await new Promise((resolve) => setImmediate(resolve));
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
