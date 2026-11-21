import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = await vi.hoisted(async () => (await import('./stackServiceMocks')).createComposeFakes());
const { isLocalAssistantStackMode, checkout } = vi.hoisted(() => ({
  isLocalAssistantStackMode: vi.fn(() => false),
  checkout: { root: '' },
}));

vi.mock('../../addons/addonComposeState', async () => (await import('./addonComposeStateStub')).addonComposeStateStub());
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
  isLocalAssistantStackMode: () => isLocalAssistantStackMode(),
}));

import { recreateHermesForProjectMounts } from '../AssistantStackService';
import { onHermesReplaced } from '../hermesLifecycle';
import { composeCalls, dockerRuntime } from './stackServiceMocks';

const { runCompose, getContainerRuntime } = fakes;

/** The services named after `up` in the one compose call. */
function upServices(): string[] {
  expect(runCompose).toHaveBeenCalledTimes(1);
  const [up] = composeCalls(runCompose);
  expect(up.command[0]).toBe('up');
  return up.command.slice(1).filter((arg) => !arg.startsWith('-'));
}

describe('recreateHermesForProjectMounts', () => {
  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-recreate-'));
    runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    getContainerRuntime.mockResolvedValue(dockerRuntime());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })) as unknown as typeof fetch);
  });

  afterEach(() => {
    fs.rmSync(checkout.root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('recreates hermes-worker with hermes on Boundary’s stack', async () => {
    isLocalAssistantStackMode.mockReturnValue(false);
    expect(await recreateHermesForProjectMounts()).toEqual({ success: true });
    expect(upServices()).toEqual(['hermes', 'hermes-webui', 'hermes-worker']);
  });

  it('turns on the shared database, GPT Researcher and OpenCode tools in Boundary’s compose env', async () => {
    isLocalAssistantStackMode.mockReturnValue(false);
    await recreateHermesForProjectMounts();
    const { env } = composeCalls(runCompose)[0];
    expect(env.SQL_MCP_ENABLED).toBe('1');
    expect(env.GPTR_MCP_ENABLED).toBe('1');
    expect(env.OPENCODE_MCP_ENABLED).toBe('1');
    expect(env.COMPOSE_PROFILES?.split(',')).toContain('coding');
    expect(env.COMPOSE_PROFILES?.split(',')).toContain('research');
  });

  it('routes web searches through search-gate and starts its profile', async () => {
    isLocalAssistantStackMode.mockReturnValue(false);
    await recreateHermesForProjectMounts();
    const { env } = composeCalls(runCompose)[0];
    expect(env.WEB_SEARCH_URL).toBe('http://search-gate:8080');
    expect(env.COMPOSE_PROFILES?.split(',')).toContain('search-gate');
  });

  it('brings up the checkout’s terminal service, which holds the context-root binds', async () => {
    isLocalAssistantStackMode.mockReturnValue(true);
    fs.writeFileSync(path.join(checkout.root, '.env'), 'HERMES_TERMINAL_BACKEND=ssh\n', 'utf8');
    expect(await recreateHermesForProjectMounts()).toEqual({ success: true });
    expect(upServices()).toEqual(['hermes', 'hermes-worker']);
  });

  it('brings up hermes alone when the checkout runs tools in hermes', async () => {
    isLocalAssistantStackMode.mockReturnValue(true);
    fs.writeFileSync(path.join(checkout.root, '.env'), 'HERMES_TERMINAL_BACKEND=local\n', 'utf8');
    expect(await recreateHermesForProjectMounts()).toEqual({ success: true });
    expect(upServices()).toEqual(['hermes']);
  });

  describe('telling add-ons', () => {
    const replaced = vi.fn();
    let off: () => void = () => {};

    beforeEach(() => {
      replaced.mockReset();
      off = onHermesReplaced(replaced);
    });

    afterEach(() => off());

    it('notifies project-mounts once on Boundary’s stack', async () => {
      isLocalAssistantStackMode.mockReturnValue(false);
      expect(await recreateHermesForProjectMounts()).toEqual({ success: true });
      expect(replaced.mock.calls).toEqual([['project-mounts']]);
    });

    it('notifies project-mounts once on a local checkout', async () => {
      isLocalAssistantStackMode.mockReturnValue(true);
      expect(await recreateHermesForProjectMounts()).toEqual({ success: true });
      expect(replaced.mock.calls).toEqual([['project-mounts']]);
    });

    it('notifies project-mounts as soon as compose recreates hermes, even when the health wait then fails', async () => {
      isLocalAssistantStackMode.mockReturnValue(false);
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as unknown as typeof fetch);
      vi.useFakeTimers();
      try {
        const pending = recreateHermesForProjectMounts();
        await vi.advanceTimersByTimeAsync(0);
        expect(replaced.mock.calls).toEqual([['project-mounts']]);
        await vi.advanceTimersByTimeAsync(130_000);
        expect((await pending).success).toBe(false);
        expect(replaced.mock.calls).toEqual([['project-mounts']]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('notifies nobody when compose fails', async () => {
      isLocalAssistantStackMode.mockReturnValue(false);
      runCompose.mockRejectedValue(new Error('up failed'));
      expect((await recreateHermesForProjectMounts()).success).toBe(false);
      expect(replaced).not.toHaveBeenCalled();
    });

    it('still succeeds when a listener rejects', async () => {
      isLocalAssistantStackMode.mockReturnValue(false);
      off();
      off = onHermesReplaced(() => Promise.reject(new Error('follow failed')));
      expect(await recreateHermesForProjectMounts()).toEqual({ success: true });
      await Promise.resolve();
    });
  });
});
