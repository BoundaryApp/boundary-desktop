import path from 'node:path';
import { vi } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import type { AddonId } from '../../../../shared/types/addons';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { localStackFiles } from '../../stackHost/localStackHost';
import type { StackFiles } from '../../stackHost/types';
import type { AddonInstallSnapshot, AddonInstallerDeps } from '../addonInstaller';
import type { AddonScriptLine, AddonScriptOutcome } from '../addonScript';

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

export const FOUR = ['twenty-db', 'twenty-redis', 'twenty-server', 'twenty-worker'];
export const ON = { TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' };
export const OFF = { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' };
/** Off with a hosted workspace left: its `crm-*` tools stay. */
export const HOSTED_ONLY = { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' };

export const okFit: AddonFit = {
  verdict: 'ok',
  memory: 'ok',
  disk: 'ok',
  port: 'ok',
  freeMiB: 6000,
  suggestedEngineMiB: null,
};

type ComposeCall = { args: string[]; env?: NodeJS.ProcessEnv };
type ScriptCall = { args: string[]; input?: Record<string, unknown>; env?: NodeJS.ProcessEnv };
type ScriptOpts = Parameters<AddonInstallerDeps['addonScript']>[1];

/** The `addon.sh` step at which a held `enable` waits for its signal to abort. */
export type HoldAt = 'pull' | 'start' | 'init';

/**
 * State of the stand-in `addon.sh`, modelled on Twenty at the stack's main (a73d000, after
 * v0.3.15), checked in `scripts/addon.sh` and `scripts/lib/addon_cli.py`:
 *
 * - `configure twenty` stores the add-on-level `local` setting, which owns
 *   `TWENTY_LOCAL_ENABLED`, prints nothing and exits 0. While `TWENTY_MCP_ENABLED` (builtin.flag)
 *   is 1 it also writes the gate flag (configure's `--flags` rule).
 * - `enable twenty` writes `TWENTY_MCP_ENABLED=1` and the stored setting's gate flag (plan-enable),
 *   pulls and starts the four services only while the gate is on (gated_names), runs the init
 *   hook (`crm.sh init`, relayed as `setup` lines with step `init`) and reloads Hermes. A stopped
 *   or failed enable writes the flags back as they were (rollback).
 * - `disable twenty` stores `local: true` when the gate is 1 and nothing is stored
 *   (plan-disable), then writes both flags 0, stops the services and reloads.
 */
export interface FakeAddonSh {
  calls: ScriptCall[];
  /** `TWENTY_*` flags in the fake `.env`. */
  flags: { TWENTY_LOCAL_ENABLED: string; TWENTY_MCP_ENABLED: string };
  /** The stored `local` setting; undefined until configure or disable stores it. */
  local?: boolean;
  /** `pull` lines enable prints while the gate is on. */
  pullLines: AddonScriptLine[];
  /** Runs when enable's init hook runs with the gate on, as `crm.sh init` writes the store. */
  onInit?: () => void;
  /** Enable's error line, after the flags were written; the flags roll back. */
  enableError: { error: string; message: string; step: string; logTail: string[] } | null;
  /** The configure exit code. */
  configureCode: number;
  /** The disable outcome when it fails. */
  disableError: { error: string; message: string; step: string; logTail: string[] } | null;
  /** Where a running enable waits for its signal to abort (exit 130, flags rolled back). */
  holdAt: HoldAt | null;
}

const done = (line: Record<string, unknown>): AddonScriptOutcome => ({ kind: 'done', done: { phase: 'done', ...line }, lines: [] });

/** The stand-in `addon.sh` for Twenty; see {@link FakeAddonSh}. */
export function fakeAddonSh(sh: FakeAddonSh) {
  return vi.fn(async (args: string[], opts: ScriptOpts = {}): Promise<AddonScriptOutcome> => {
    sh.calls.push({ args, input: opts.input, env: opts.env });
    const [command, id] = args;
    if (id !== 'twenty') throw new Error(`unexpected addon.sh ${args.join(' ')}`);
    if (command === 'configure') {
      if (sh.configureCode !== 0) return { kind: 'exited', code: sh.configureCode, logTail: ['error: busy'], lines: [] };
      sh.local = opts.input?.local === true;
      if (sh.flags.TWENTY_MCP_ENABLED === '1') sh.flags.TWENTY_LOCAL_ENABLED = sh.local ? '1' : '0';
      return { kind: 'exited', code: 0, logTail: [], lines: [] };
    }
    if (command === 'disable') {
      if (sh.disableError) return { kind: 'error', ...sh.disableError, lines: [] };
      if (sh.flags.TWENTY_LOCAL_ENABLED === '1' && sh.local === undefined) sh.local = true;
      sh.flags = { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' };
      return done({ addon: 'twenty', action: 'disable' });
    }
    if (command !== 'enable') throw new Error(`unexpected addon.sh ${args.join(' ')}`);
    const before = { ...sh.flags };
    const line = (l: AddonScriptLine) => opts.onLine?.(l);
    const held = async (at: HoldAt): Promise<AddonScriptOutcome | null> => {
      if (sh.holdAt !== at) return null;
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) resolve();
        opts.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      sh.flags = before;
      return { kind: 'exited', code: 130, logTail: [], lines: [] };
    };
    const gateOn = (sh.local ?? sh.flags.TWENTY_LOCAL_ENABLED === '1') === true;
    if (gateOn) {
      for (const l of sh.pullLines) line(l);
      const stopped = await held('pull');
      if (stopped) return stopped;
    }
    sh.flags = { TWENTY_MCP_ENABLED: '1', TWENTY_LOCAL_ENABLED: gateOn ? '1' : '0' };
    line({ phase: 'setup', step: 'flags', status: 'running' });
    line({ phase: 'setup', step: 'flags', status: 'done' });
    line({ phase: 'setup', step: 'start', status: 'running' });
    const stoppedAtStart = await held('start');
    if (stoppedAtStart) return stoppedAtStart;
    line({ phase: 'setup', step: 'start', status: 'done' });
    if (gateOn) {
      line({ phase: 'setup', step: 'init', status: 'running', message: 'owner account: running' });
      const stoppedAtInit = await held('init');
      if (stoppedAtInit) return stoppedAtInit;
      sh.onInit?.();
    }
    if (sh.enableError) {
      sh.flags = before;
      return { kind: 'error', ...sh.enableError, lines: [] };
    }
    line({ phase: 'setup', step: 'reload', status: 'running' });
    line({ phase: 'setup', step: 'reload', status: 'done' });
    return done({ addon: 'twenty', action: 'enable', mcp: gateOn ? ['crm-main'] : [] });
  });
}

/** Stand-ins for compose and `addon.sh`. */
/**
 * `stackRoot` gives the test the real files under that folder, with `<root>/data` as both the
 * data and the user-content folder.
 */
export function fakeDeps({ stackRoot, ...overrides }: Partial<AddonInstallerDeps> & { stackRoot?: string } = {}) {
  const calls: ComposeCall[] = [];
  const state = { config: '' };
  const sh: FakeAddonSh = {
    calls: [],
    flags: { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' },
    pullLines: [],
    enableError: null,
    configureCode: 0,
    disableError: null,
    holdAt: null,
  };
  const deps: AddonInstallerDeps = {
    checkFit: vi.fn(async () => okFit),
    makeRoom: vi.fn(async () => undefined),
    compose: vi.fn(async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: opts?.env });
      if (args.includes('config')) return { stdout: state.config, stderr: '' };
      return { stdout: '', stderr: '' };
    }),
    addonScript: fakeAddonSh(sh),
    reloadHermes: vi.fn(async () => ({ success: true })),
    setInstalled: vi.fn(),
    isInstalled: vi.fn(async () => false),
    isLocalStack: vi.fn(() => false),
    removeImages: vi.fn(async (images: string[]) => ({ removed: images, kept: [] as string[] })),
    ownerName: vi.fn(async () => ({ first: 'Ada', last: 'Lovelace' })),
    files: undefined as unknown as StackFiles,
    ...overrides,
  };
  // Without a stack root the files are in memory: real file I/O doesn't advance with fake
  // timers, so a test that holds them would stall on it.
  if (!overrides.files) {
    deps.files = stackRoot
      ? localStackFiles({ stackRoot, userContentRoot: () => path.join(stackRoot, 'data') })
      : createFakeStackFiles();
  }
  return { deps, calls, state, sh };
}

/** The `addon.sh` commands run, as `configure:<local>`, `enable` or `disable`. */
export function scriptRuns(sh: FakeAddonSh): string[] {
  return sh.calls.map((c) => (c.args[0] === 'configure' ? `configure:${String(c.input?.local)}` : c.args[0]!));
}

export function statuses(s: AddonInstallSnapshot | null): Record<string, string> {
  return Object.fromEntries((s?.steps ?? []).map((step) => [step.id, step.status]));
}
