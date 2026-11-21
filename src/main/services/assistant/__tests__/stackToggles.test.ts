/**
 * The web search mode switch, which changes a running stack: it saves its setting, then
 * recreates hermes when the stack is up. n8n and LightRAG are add-ons (builtinAddons.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = await vi.hoisted(async () => (await import('./stackServiceMocks')).createComposeFakes());
const { saved, mode } = vi.hoisted(() => ({
  saved: { mode: 'private' as string },
  mode: { attachLive: false },
}));

vi.mock('../../addons/addonComposeState', async () => (await import('./addonComposeStateStub')).addonComposeStateStub());
vi.mock('../../containerRuntime', async (importOriginal) =>
  (await import('./stackServiceMocks')).containerRuntimeMock(await importOriginal(), fakes)
);

vi.mock('../resolveAssistantRoot', async () => {
  const { resolveAssistantRootMock, STACK_ROOT } = await import('./stackServiceMocks');
  return resolveAssistantRootMock(() => STACK_ROOT);
});

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  ...(await import('./stackServiceMocks')).composePathMocks(),
  resolveAssistantDataRoot: () => '/tmp/boundary-project/data',
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

import {
  getWebSearchModeState,
  setWebSearchModeRunning,
  __test,
} from '../AssistantStackService';
import { onHermesReplaced } from '../hermesLifecycle';
import { composeCalls as parseComposeCalls, dockerRuntime } from './stackServiceMocks';

const { runCompose } = fakes;
const composeCalls = () => parseComposeCalls(runCompose);

/** The one compose call's subcommand and what follows it, without the project and profile flags. */
function composeCommand(): string[] {
  expect(runCompose).toHaveBeenCalledTimes(1);
  return composeCalls()[0].command;
}

let healthy = true;

beforeEach(() => {
  saved.mode = 'private';
  mode.attachLive = false;
  healthy = true;
  runCompose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  fakes.getContainerRuntime.mockResolvedValue(dockerRuntime());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: healthy })) as unknown as typeof fetch);
});

afterEach(() => {
  __test.resetReadyForTests();
  vi.unstubAllGlobals();
});

describe('setWebSearchModeRunning', () => {
  it('saves the mode and recreates hermes with it in the compose env', async () => {
    expect(await setWebSearchModeRunning('private-first')).toEqual({ success: true });
    expect(saved.mode).toBe('private-first');
    const calls = composeCalls();
    expect(calls.map((call) => call.command)).toEqual([['up', '-d', '--no-deps', 'hermes']]);
    expect(calls[0].env.HERMES_WEB_SEARCH_MODE).toBe('private-first');
  });

  it('notifies web-search once after hermes is recreated and healthy', async () => {
    const replaced = vi.fn();
    const off = onHermesReplaced(replaced);
    try {
      expect(await setWebSearchModeRunning('private-first')).toEqual({ success: true });
      expect(replaced.mock.calls).toEqual([['web-search']]);
    } finally {
      off();
    }
  });

  it('notifies web-search as soon as compose recreates hermes, even when the health wait then fails', async () => {
    const replaced = vi.fn();
    const off = onHermesReplaced(replaced);
    // Healthy for the running check, then never again once hermes is recreated.
    runCompose.mockImplementation(async () => {
      healthy = false;
      return { stdout: '', stderr: '' };
    });
    vi.useFakeTimers();
    try {
      const pending = setWebSearchModeRunning('private-first');
      await vi.advanceTimersByTimeAsync(0);
      expect(replaced.mock.calls).toEqual([['web-search']]);
      await vi.advanceTimersByTimeAsync(130_000);
      expect((await pending).success).toBe(false);
      expect(replaced.mock.calls).toEqual([['web-search']]);
    } finally {
      vi.useRealTimers();
      off();
    }
  });

  it('notifies nobody when hermes fails to restart, or when the stack is down', async () => {
    const replaced = vi.fn();
    const off = onHermesReplaced(replaced);
    try {
      runCompose.mockRejectedValue(new Error('recreate failed'));
      expect((await setWebSearchModeRunning('keyless-first')).success).toBe(false);
      healthy = false;
      expect(await setWebSearchModeRunning('keyless')).toEqual({ success: true });
      expect(replaced).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('still succeeds when a listener rejects', async () => {
    const off = onHermesReplaced(() => Promise.reject(new Error('follow failed')));
    try {
      expect(await setWebSearchModeRunning('private-first')).toEqual({ success: true });
      await Promise.resolve();
    } finally {
      off();
    }
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

  it('leaves the choice to the local stack’s .env under dev:local-stack', async () => {
    mode.attachLive = true;
    const result = await setWebSearchModeRunning('keyless');
    expect(result.success).toBe(false);
    expect(saved.mode).toBe('private');
    expect((await getWebSearchModeState()).canChange).toBe(false);
  });
});
