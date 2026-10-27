import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCompose = vi.fn();
const getContainerRuntime = vi.fn();
const { isLocalAssistantStackMode, checkout } = vi.hoisted(() => ({
  isLocalAssistantStackMode: vi.fn(() => false),
  checkout: { root: '' },
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
  tryResolveAssistantRoot: () => ({ root: checkout.root, error: undefined }),
  resolveAssistantRoot: () => checkout.root,
}));

vi.mock('../assistantPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../assistantPaths')>()),
  resolveBoundaryOverlayPath: () => '/tmp/docker-compose.boundary.yml',
  resolveAssistantWorkspaceRoot: () => '/tmp/assistant-workspace',
  ensureOpenCodeConfigFile: async () => '/tmp/opencode.json',
}));

vi.mock('../localStackMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../localStackMode')>()),
  isLocalAssistantStackMode: () => isLocalAssistantStackMode(),
}));

import { recreateHermesForProjectMounts } from '../AssistantStackService';

/** The services named after `up` in the one compose call. */
function upServices(): string[] {
  expect(runCompose).toHaveBeenCalledTimes(1);
  const args = runCompose.mock.calls[0][1] as string[];
  return args.slice(args.indexOf('up') + 1).filter((arg) => !arg.startsWith('-'));
}

describe('recreateHermesForProjectMounts', () => {
  beforeEach(() => {
    checkout.root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-recreate-'));
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
});
