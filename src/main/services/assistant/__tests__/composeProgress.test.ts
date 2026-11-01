import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot, seedServiceProgress } from '../../../../shared/assistantStackLifecycle';

const runComposeStreaming = vi.fn();
const runCompose = vi.fn();
const runCli = vi.fn();

vi.mock('../../containerRuntime', async () => {
  const actual = await vi.importActual<typeof import('../../containerRuntime')>('../../containerRuntime');
  return {
    ...actual,
    getContainerRuntime: async () => ({ kind: 'docker', cliPath: 'docker', composeArgv: ['compose'], env: {} }),
    runCompose: (...args: unknown[]) => runCompose(...args),
    runComposeStreaming: (...args: unknown[]) => runComposeStreaming(...args),
    runCli: (...args: unknown[]) => runCli(...args),
  };
});

vi.mock('../resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: '/tmp/fake-assistant', error: undefined }),
  resolveAssistantRoot: () => '/tmp/fake-assistant',
}));

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantDataRoot: () => '/tmp/assistant-data',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
}));

vi.mock('../hermes/hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes/hermesProjectsOverlay')>()),
  hermesProjectsOverlayExists: () => false,
}));

import { __test, stopAssistantStack } from '../AssistantStackService';

/** `compose ps` runs so far. */
function psCalls(): number {
  return runCompose.mock.calls.filter(([, args]) => (args as string[]).includes('ps')).length;
}

/** A streaming run the test finishes by calling `finish`. */
function heldStream(): { finish: (result: { code: number; stdout?: string; stderr?: string }) => void; emit: (line: string) => void } {
  let resolve!: (value: unknown) => void;
  let onLine: ((line: string) => void) | undefined;
  runComposeStreaming.mockImplementationOnce((_runtime: unknown, _args: string[], options: { onStdoutLine?: (l: string) => void }) => {
    onLine = options.onStdoutLine;
    return new Promise((r) => {
      resolve = r;
    });
  });
  return {
    emit: (line) => onLine?.(line),
    finish: ({ code, stdout = '', stderr = '' }) => resolve({ code, stdout, stderr, timedOut: false }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  runComposeStreaming.mockReset();
  runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  runCli.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  __test.resetLifecycle();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('compose ps polling during a streamed run', () => {
  it('stops polling once JSON progress events arrive', async () => {
    const stream = heldStream();
    const stopping = stopAssistantStack();
    await vi.advanceTimersByTimeAsync(3_100);
    const before = psCalls();
    expect(before).toBeGreaterThanOrEqual(2);

    stream.emit(JSON.stringify({ id: 'Container boundary-hermes', status: 'Stopping', text: 'Stopping' }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(psCalls()).toBe(before);

    stream.finish({ code: 0 });
    expect(await stopping).toEqual({ success: true });
  });

  it('reports a failed run whose output mentions progress instead of re-running without JSON', async () => {
    runComposeStreaming.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr: 'Error response from daemon: removal of container boundary-hermes is already in progress',
      timedOut: false,
    });
    const result = await stopAssistantStack();
    expect(result.success).toBe(false);
    expect(result.error).toContain('already in progress');
    // Only the streamed run: no plain `compose stop` retry.
    expect(runCompose.mock.calls.filter(([, args]) => (args as string[]).includes('stop'))).toHaveLength(0);
  });

  it('leaves no poll running after the run ends', async () => {
    const stream = heldStream();
    const stopping = stopAssistantStack();
    await vi.advanceTimersByTimeAsync(1_600);
    stream.finish({ code: 1, stderr: 'unknown flag: --progress' });
    await stopping;
    const after = psCalls();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(psCalls()).toBe(after);
  });
});

describe('applyPsRow', () => {
  const hermes = () => {
    __test.setLifecycleSnapshot(
      createLifecycleSnapshot('starting', { services: seedServiceProgress('working', 'Starting…', 0.5) })
    );
    return __test.getLifecycleSnapshot().services;
  };
  const card = (services: ReturnType<typeof hermes>) => services.find((s) => s.containerName === 'boundary-hermes');

  it('marks a healthy container done from Health, though State is the bare state', () => {
    const next = __test.applyPsRow(hermes(), {
      Name: 'boundary-hermes',
      State: 'running',
      Status: 'Up 2 minutes (healthy)',
      Health: 'healthy',
    });
    expect(card(next)).toMatchObject({ state: 'done', statusText: 'Healthy' });
  });

  it('reads Status when there is no health check', () => {
    const next = __test.applyPsRow(hermes(), { Name: 'boundary-hermes', State: 'running', Status: 'Up 5 seconds', Health: '' });
    expect(card(next)).toMatchObject({ state: 'working', statusText: 'Started' });
  });

  it('does not count an unhealthy container as healthy', () => {
    const next = __test.applyPsRow(hermes(), {
      Name: 'boundary-hermes',
      State: 'running',
      Status: 'Up 2 minutes (unhealthy)',
      Health: 'unhealthy',
    });
    expect(card(next)?.state).not.toBe('done');
  });
});
