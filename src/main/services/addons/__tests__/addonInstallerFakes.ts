import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import type { AddonId } from '../../../../shared/types/addons';
import type { AddonInstallSnapshot, AddonInstallerDeps } from '../addonInstaller';

/**
 * Shared fakes for the addonInstaller tests, which are split by flow across
 * `addonInstaller*.test.ts`. Each of those files mocks the installer's stack modules with the
 * factories below:
 *
 *   vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
 */

/** The stack store's pending-change list, which `pendingRestart` reads and writes. */
export const pending = { list: [] as string[] };

export const assistantStackServiceMock = () => ({
  getAssistantStackAccess: vi.fn(),
  reloadHermesForAddons: vi.fn(),
});

export const storeMock = () => ({
  getInstalledAddons: (): AddonId[] => [],
  setAddonInstalled: vi.fn(),
  getPendingAddonChanges: () => pending.list,
  setPendingAddonChanges: (_root: string, list: string[]) => {
    pending.list = list;
  },
});

export const resolveAssistantRootMock = () => ({ tryResolveAssistantRoot: () => ({ root: '/stacks/test' }) });

export const localStackModeMock = () => ({ isLocalAssistantStackMode: vi.fn(() => false) });

export const addonHostFactsMock = () => ({ readAddonHostFacts: vi.fn() });

/** A folder per test file: install creates data/twenty/{db,storage} under its dataRoot. */
const FAKE_STACK = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-installer-fake-stack-'));

export const FOUR = ['twenty-db', 'twenty-redis', 'twenty-server', 'twenty-worker'];
export const ON = { TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' };
export const OFF = { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' };

export const okFit: AddonFit = {
  verdict: 'ok',
  memory: 'ok',
  disk: 'ok',
  port: 'ok',
  freeMiB: 6000,
  suggestedEngineMiB: null,
};

export function psRow(health: string): string {
  return JSON.stringify({ Service: 'twenty-server', State: 'running', Health: health });
}

type ComposeCall = { args: string[]; env?: NodeJS.ProcessEnv };

/** Stand-ins for compose and crm.sh. `serverHealth` is what `ps` reports for twenty-server. */
export function fakeDeps(overrides: Partial<AddonInstallerDeps> = {}) {
  const calls: ComposeCall[] = [];
  const streamCalls: ComposeCall[] = [];
  const state = { serverHealth: 'healthy', serverLogs: '', config: '', setupCode: 0, setupLines: [] as string[] };
  const deps: AddonInstallerDeps = {
    checkFit: vi.fn(async () => okFit),
    makeRoom: vi.fn(async () => undefined),
    compose: vi.fn(async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: opts?.env });
      if (args.includes('ps')) return { stdout: psRow(state.serverHealth), stderr: '' };
      if (args.includes('logs')) return { stdout: state.serverLogs, stderr: '' };
      if (args.includes('config')) return { stdout: state.config, stderr: '' };
      return { stdout: '', stderr: '' };
    }),
    composeStreaming: vi.fn(async (args: string[], _onLine: (l: string) => void, env?: NodeJS.ProcessEnv) => {
      streamCalls.push({ args, env });
      return { code: 0 };
    }),
    runSetup: vi.fn(async (onLine: (l: string) => void) => {
      for (const line of state.setupLines) onLine(line);
      return { code: state.setupCode };
    }),
    reloadHermes: vi.fn(async () => ({ success: true })),
    setInstalled: vi.fn(),
    isInstalled: vi.fn(() => false),
    isLocalStack: vi.fn(() => false),
    syncStackFlags: vi.fn(async () => undefined),
    removeImages: vi.fn(async (images: string[]) => ({ removed: images, kept: [] as string[] })),
    ownerName: vi.fn(async () => ({ first: 'Ada', last: 'Lovelace' })),
    stackPaths: vi.fn(() => ({ root: FAKE_STACK, dataRoot: path.join(FAKE_STACK, 'data') })),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
  return { deps, calls, streamCalls, state };
}

export function statuses(s: AddonInstallSnapshot | null): Record<string, string> {
  return Object.fromEntries((s?.steps ?? []).map((step) => [step.id, step.status]));
}
