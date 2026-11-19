import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSpawn } from '../../__tests__/fakeChild';
import { fakeDeps } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import {
  createAddonInstaller,
  getAddonInstaller,
  readOwnerName,
  routeAddonInstaller,
  runAddonSetupScript,
  runExclusive,
  type AddonInstaller,
  type AddonInstallSnapshot,
  type AddonInstallerDeps,
} from '../addonInstaller';
import type { ActualInstaller } from '../actualInstaller';
import type { BitwardenInstaller } from '../bitwardenInstaller';
import type { EmailInstaller } from '../emailInstaller';

describe('runExclusive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses other work while an install runs, and an install while other work runs', async () => {
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(runExclusive(async () => 'connected')).rejects.toThrow('An add-on install is already running.');
    state.serverHealth = 'healthy';
    await vi.advanceTimersByTimeAsync(2_000);
    await first;

    let release!: () => void;
    const held = runExclusive(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(installer.install('twenty')).rejects.toThrow('An add-on install is already running.');
    release();
    await held;
    await expect(runExclusive(async () => 'connected')).resolves.toBe('connected');
  });
});

describe('readOwnerName', () => {
  const run = (stdout: string) => vi.fn(async () => ({ stdout }));

  it('splits id -F at the first space', async () => {
    const execFile = run('Ada King Lovelace\n');
    expect(await readOwnerName(execFile)).toEqual({ first: 'Ada', last: 'King Lovelace' });
    expect(execFile).toHaveBeenCalledWith('id', ['-F']);
    expect(await readOwnerName(run('Ada\n'))).toEqual({ first: 'Ada', last: '' });
  });

  it('falls back to Owner when id fails or prints nothing', async () => {
    expect(await readOwnerName(run('  \n'))).toEqual({ first: 'Owner', last: '' });
    const failing = vi.fn(async () => {
      throw new Error('id: illegal option');
    });
    expect(await readOwnerName(failing)).toEqual({ first: 'Owner', last: '' });
  });
});

describe('getAddonInstaller', () => {
  it('returns one installer for the app, idle until asked', () => {
    expect(getAddonInstaller()).toBe(getAddonInstaller());
    expect(getAddonInstaller().snapshot()).toBeNull();
  });
});

describe('Twenty data folders before start', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-data-dirs-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Records whether both bind sources exist when `up` runs. */
  function depsSeeingDirs(overrides: Partial<AddonInstallerDeps> = {}) {
    const atUp: boolean[] = [];
    const made = fakeDeps({ stackPaths: () => ({ root: dir, dataRoot: path.join(dir, 'data') }), ...overrides });
    const compose = vi.mocked(made.deps.compose);
    const base = compose.getMockImplementation()!;
    compose.mockImplementation(async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (args.includes('up')) {
        atUp.push(['db', 'storage'].every((sub) => fs.existsSync(path.join(dir, 'data', 'twenty', sub))));
      }
      return base(args, opts);
    });
    return { ...made, atUp };
  }

  it('creates data/twenty/db and data/twenty/storage before up in the managed stack', async () => {
    const { deps, atUp } = depsSeeingDirs();
    await createAddonInstaller(deps).install('twenty');
    expect(atUp).toEqual([true]);
  });

  it("leaves a local checkout's folders to the stack's own scripts", async () => {
    const { deps, atUp } = depsSeeingDirs({ isLocalStack: vi.fn(() => true) });
    await createAddonInstaller(deps).install('twenty');
    expect(atUp).toEqual([false]);
    expect(fs.existsSync(path.join(dir, 'data', 'twenty'))).toBe(false);
  });

  it('stops at start without calling up when a folder cannot be made', async () => {
    fs.writeFileSync(path.join(dir, 'data'), 'a file where the data folder goes');
    const { deps, atUp } = depsSeeingDirs();
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(atUp).toEqual([]);
    expect(installer.snapshot()?.error?.step).toBe('start');
    expect(installer.snapshot()?.error?.message).toBe("Twenty CRM's data folders couldn't be created.");
  });
});

describe('runAddonSetupScript', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs bash scripts/crm.sh init in the stack root and passes each line on', async () => {
    // The second line comes on stderr, split across two chunks.
    const { impl, calls } = fakeSpawn({
      stdout: ['[crm] Generated the owner password\n'],
      stderr: ['[cr', 'm] Next: make hermes-reload\n'],
    });
    const lines: string[] = [];
    const run = runAddonSetupScript({
      root: '/stack',
      env: { PATH: '/usr/bin', TWENTY_LOCAL_ENABLED: '1' },
      onLine: (l) => lines.push(l),
      spawnImpl: impl,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toEqual({ code: 0 });
    expect(calls[0].command).toBe('bash');
    expect(calls[0].args).toEqual(['scripts/crm.sh', 'init']);
    expect(calls[0].options.cwd).toBe('/stack');
    expect(calls[0].options.env).toEqual({ PATH: '/usr/bin', TWENTY_LOCAL_ENABLED: '1' });
    expect(lines).toEqual(['[crm] Generated the owner password', '[crm] Next: make hermes-reload']);
  });

  it('resolves with the exit code of a failing script', async () => {
    const { impl } = fakeSpawn({ stdout: ['[crm] ERROR: Docker daemon is not running\n'], code: 1 });
    const run = runAddonSetupScript({ root: '/stack', env: {}, onLine: () => {}, spawnImpl: impl });
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toEqual({ code: 1 });
  });

  it('reports a missing bash as code 127 with the error as a line', async () => {
    const { impl } = fakeSpawn({ fail: true });
    const lines: string[] = [];
    const run = runAddonSetupScript({ root: '/stack', env: {}, onLine: (l) => lines.push(l), spawnImpl: impl });
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toEqual({ code: 127 });
    expect(lines).toEqual(['spawn bash ENOENT']);
  });

  it('stops a script that runs past the timeout', async () => {
    const { impl, kills } = fakeSpawn({ hang: true });
    const lines: string[] = [];
    const run = runAddonSetupScript({
      root: '/stack',
      env: {},
      onLine: (l) => lines.push(l),
      spawnImpl: impl,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(kills).toEqual(['SIGTERM']);
    expect(await run).toEqual({ code: 124 });
    expect(lines.at(-1)).toBe('crm.sh init ran for more than 1 s and was stopped.');
  });

  it('stops the script when its signal aborts and resolves with 130', async () => {
    const { impl, kills } = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const run = runAddonSetupScript({ root: '/stack', env: {}, onLine: () => {}, spawnImpl: impl, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(kills).toEqual([]);
    controller.abort();
    expect(kills).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toEqual({ code: 130 });
  });
});

describe('routeAddonInstaller', () => {
  function fakeRunner() {
    const listeners = new Set<(s: AddonInstallSnapshot) => void>();
    let snap: AddonInstallSnapshot | null = null;
    const calls: string[] = [];
    const call = (name: string) => async (): Promise<void> => {
      calls.push(name);
    };
    return {
      calls,
      emit(next: AddonInstallSnapshot) {
        snap = next;
        listeners.forEach((cb) => cb(next));
      },
      runner: {
        install: call('install'),
        cancel: (): void => {
          calls.push('cancel');
        },
        undo: call('undo'),
        restart: call('restart'),
        start: call('start'),
        turnOff: call('turnOff'),
        remove: call('remove'),
        snapshot: () => snap,
        onChange: (cb: (s: AddonInstallSnapshot) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    };
  }

  it('sends Actual’s runs to its installer and the rest to compose, with the latest snapshot', async () => {
    const compose = fakeRunner();
    const actual = fakeRunner();
    const routed = routeAddonInstaller(compose.runner as unknown as AddonInstaller, actual.runner as unknown as ActualInstaller);
    const seen: string[] = [];
    routed.onChange((s) => seen.push(s.id));
    await routed.install('actual', { access: 'read' });
    await routed.turnOff('twenty');
    await routed.remove('actual', { deleteImages: false });
    expect(actual.calls).toEqual(['install', 'remove']);
    expect(compose.calls).toEqual(['turnOff']);
    await expect(routed.restart('actual')).rejects.toThrow('Nothing is waiting for a restart.');
    actual.emit({ id: 'actual', kind: 'install', steps: [], done: false });
    compose.emit({ id: 'twenty', kind: 'install', steps: [], done: true });
    expect(routed.snapshot()?.id).toBe('twenty');
    expect(seen).toEqual(['actual', 'twenty']);
  });

  it('sends Bitwarden’s runs to its installer, with no restart and no image choice', async () => {
    const compose = fakeRunner();
    const actual = fakeRunner();
    const bitwarden = fakeRunner();
    const routed = routeAddonInstaller(
      compose.runner as unknown as AddonInstaller,
      actual.runner as unknown as ActualInstaller,
      bitwarden.runner as unknown as BitwardenInstaller
    );
    await routed.install('bitwarden');
    await routed.turnOff('bitwarden');
    await routed.remove('bitwarden', { deleteImages: true });
    expect(bitwarden.calls).toEqual(['install', 'turnOff', 'remove']);
    expect(compose.calls).toEqual([]);
    await expect(routed.restart('bitwarden')).rejects.toThrow('Nothing is waiting for a restart.');
    bitwarden.emit({ id: 'bitwarden', kind: 'install', steps: [], done: true });
    expect(routed.snapshot()?.id).toBe('bitwarden');
  });

  it('sends email’s runs to its installer with the saved account, with no restart', async () => {
    const compose = fakeRunner();
    const actual = fakeRunner();
    const email = fakeRunner();
    const installs: unknown[][] = [];
    email.runner.install = (async (...args: unknown[]) => {
      installs.push(args);
    }) as typeof email.runner.install;
    const routed = routeAddonInstaller(
      compose.runner as unknown as AddonInstaller,
      actual.runner as unknown as ActualInstaller,
      undefined,
      email.runner as unknown as EmailInstaller
    );
    await routed.install('email', { email: { account: 'home' } });
    await routed.turnOff('email');
    await routed.remove('email', { deleteImages: false });
    expect(installs).toEqual([['home']]);
    expect(email.calls).toEqual(['turnOff', 'remove']);
    expect(compose.calls).toEqual([]);
    await expect(routed.restart('email')).rejects.toThrow('Nothing is waiting for a restart.');
    email.emit({ id: 'email', kind: 'install', steps: [], done: true });
    expect(routed.snapshot()?.id).toBe('email');
  });
});
