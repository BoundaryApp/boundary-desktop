import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    const { deps, sh } = fakeDeps();
    sh.holdAt = 'start';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(runExclusive(async () => 'connected')).rejects.toThrow('An add-on install is already running.');
    installer.cancel('twenty');
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

describe('Twenty data folders before enable', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-data-dirs-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Records whether both bind sources exist when `addon.sh enable` runs `up`. */
  function depsSeeingDirs(overrides: Partial<AddonInstallerDeps> = {}) {
    const atUp: boolean[] = [];
    const made = fakeDeps({ stackRoot: dir, ...overrides });
    const script = vi.mocked(made.deps.addonScript);
    const base = script.getMockImplementation()!;
    script.mockImplementation(async (args, opts) => {
      if (args[0] === 'enable') {
        atUp.push(['db', 'storage'].every((sub) => fs.existsSync(path.join(dir, 'data', 'twenty', sub))));
      }
      return base(args, opts);
    });
    return { ...made, atUp };
  }

  it('creates data/twenty/db and data/twenty/storage before enable in the managed stack', async () => {
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

  it('stops at start without running addon.sh when a folder cannot be made', async () => {
    fs.writeFileSync(path.join(dir, 'data'), 'a file where the data folder goes');
    const made = depsSeeingDirs();
    const { deps, atUp } = made;
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(atUp).toEqual([]);
    expect(made.sh.calls).toEqual([]);
    expect(installer.snapshot()?.error?.step).toBe('start');
    expect(installer.snapshot()?.error?.message).toBe("Twenty CRM's data folders couldn't be created.");
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
