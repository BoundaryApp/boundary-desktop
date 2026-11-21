import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingChanges } from '../pendingRestart';
import { FOUR, OFF, ON, fakeDeps, pending, scriptRuns, statuses, type HoldAt } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { createAddonInstaller } from '../addonInstaller';
import { LOCAL_SETTINGS, WORK_SETTINGS, writeTwentyWorkspace, twentyWorkspacesDir } from './twentyStoreFixtures';

/** A promise and the function that settles it, for holding a fake call open. */
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const RM_ALL = ['--profile', 'crm', 'rm', '-s', '-f', ...FOUR];

describe('cancelling an install', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pending.list = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Starts an install whose `enable` waits at `at`, and cancels it there. */
  async function cancelAt(at: HoldAt) {
    const fake = fakeDeps();
    const signals: Array<AbortSignal | undefined> = [];
    const script = vi.mocked(fake.deps.addonScript);
    const base = script.getMockImplementation()!;
    script.mockImplementation((args, opts) => {
      signals.push(opts?.signal);
      return base(args, opts);
    });
    fake.sh.holdAt = at;
    const installer = createAddonInstaller(fake.deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    const running = installer.snapshot()?.steps.find((s) => s.status === 'running')?.id;
    fake.sh.holdAt = null;
    installer.cancel('twenty');
    expect(installer.snapshot()?.cancelling).toBe(true);
    await done;
    return { ...fake, installer, running, enableSignal: signals[1] };
  }

  it('during the download stops enable, then turns the local instance off again', async () => {
    const { installer, running, enableSignal, sh, calls, deps } = await cancelAt('pull');
    expect(running).toBe('download');
    expect(enableSignal?.aborted).toBe(true);

    const snap = installer.snapshot();
    expect(snap?.cancelled).toBe(true);
    expect(snap?.done).toBe(true);
    expect(snap?.cancelling).toBe(false);
    expect(snap?.error).toBeUndefined();
    expect(statuses(snap)).toMatchObject({ check: 'done', download: 'cancelled', start: 'pending' });
    expect(scriptRuns(sh)).toEqual(['configure:true', 'enable', 'configure:false', 'disable']);
    expect(sh.flags).toEqual(OFF);
    expect(sh.local).toBe(false);
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('while the services start stops enable and removes the containers', async () => {
    const { installer, running, sh, calls, deps } = await cancelAt('start');
    expect(running).toBe('answer');
    expect(installer.snapshot()?.cancelled).toBe(true);
    expect(statuses(installer.snapshot())).toMatchObject({ start: 'done', answer: 'cancelled', setup: 'pending' });
    expect(sh.flags).toEqual(OFF);
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('during setup stops crm.sh init and removes the containers', async () => {
    const { installer, running, sh, calls, deps } = await cancelAt('init');
    expect(running).toBe('setup');
    const snap = installer.snapshot();
    expect(snap?.cancelled).toBe(true);
    expect(snap?.error).toBeUndefined();
    expect(statuses(snap)).toMatchObject({ setup: 'cancelled', restart: 'pending' });
    expect(sh.flags).toEqual(OFF);
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('after enable finished still turns the local instance off again', async () => {
    const ref: { installer?: ReturnType<typeof createAddonInstaller> } = {};
    const { deps, calls, sh } = fakeDeps();
    const script = vi.mocked(deps.addonScript);
    const base = script.getMockImplementation()!;
    script.mockImplementation(async (args, opts) => {
      const outcome = await base(args, opts);
      if (args[0] === 'enable' && outcome.kind === 'done') ref.installer?.cancel('twenty');
      return outcome;
    });
    const installer = createAddonInstaller(deps);
    ref.installer = installer;
    await installer.install('twenty');

    expect(installer.snapshot()?.cancelled).toBe(true);
    expect(statuses(installer.snapshot()).restart).toBe('pending');
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(sh.flags).toEqual(OFF);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('records a failure with Undo install still to do when the containers can’t be removed', async () => {
    const fake = fakeDeps();
    const compose = vi.mocked(fake.deps.compose);
    compose.mockImplementation(async (args: string[]) => {
      if (args.includes('rm')) throw Object.assign(new Error('rm failed'), { stderr: 'Error response from daemon' });
      return { stdout: '', stderr: '' };
    });
    fake.sh.holdAt = 'start';
    const installer = createAddonInstaller(fake.deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    installer.cancel('twenty');
    await done;

    const snap = installer.snapshot();
    expect(snap?.cancelled).toBeFalsy();
    expect(snap?.cancelling).toBe(false);
    expect(snap?.error).toEqual({
      step: 'answer',
      message: "Cancelled, but Twenty CRM couldn't be turned off again.",
      logTail: ['Error response from daemon'],
    });
    expect(statuses(snap).answer).toBe('error');
  });

  it('is refused with nothing running, and once the install waits for its restart', async () => {
    const { deps } = fakeDeps();
    const installer = createAddonInstaller(deps);
    expect(() => installer.cancel('twenty')).toThrow('Nothing here can be cancelled now.');
    await installer.install('twenty');
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
    expect(() => installer.cancel('twenty')).toThrow('Nothing here can be cancelled now.');
  });

  it('frees the installer for the next run', async () => {
    const { installer, sh } = await cancelAt('start');
    sh.holdAt = null;
    await installer.install('twenty');
    expect(installer.snapshot()?.cancelled).toBeUndefined();
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
    expect(sh.flags).toEqual(ON);
  });
});

describe('stopping a removal', () => {
  let tmp: string;
  let root: string;
  let dataRoot: string;
  let wsDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    pending.list = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-remove-cancel-'));
    root = path.join(tmp, 'root');
    dataRoot = path.join(root, 'data');
    wsDir = twentyWorkspacesDir(root);
    fs.mkdirSync(path.join(dataRoot, 'twenty', 'db'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'twenty', 'db', 'f'), 'x');
    writeTwentyWorkspace(wsDir, 'main', LOCAL_SETTINGS, { keyRw: 'k' });
    writeTwentyWorkspace(wsDir, 'work', WORK_SETTINGS, { keyRw: 'k' });
    fs.writeFileSync(path.join(root, '.env'), 'TWENTY_PASSWORD=secret\n');
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lets the running stop finish, then ends before deleting, with the Turn off pending line', async () => {
    const stop = held<{ stdout: string; stderr: string }>();
    const { deps, calls } = fakeDeps({ stackRoot: root, isInstalled: vi.fn(async () => true) });
    const compose = vi.mocked(deps.compose);
    const base = compose.getMockImplementation()!;
    compose.mockImplementation(async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (args.includes('stop')) {
        calls.push({ args });
        return stop.promise;
      }
      return base(args, opts);
    });
    const installer = createAddonInstaller(deps);
    const done = installer.remove('twenty', { deleteImages: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(installer.snapshot()).stop).toBe('running');

    installer.cancel('twenty');
    expect(installer.snapshot()?.cancelling).toBe(true);
    stop.release({ stdout: '', stderr: '' });
    await done;

    const snap = installer.snapshot();
    expect(snap?.cancelled).toBe(true);
    expect(snap?.done).toBe(true);
    expect(statuses(snap)).toEqual({
      stop: 'done',
      'remove-containers': 'pending',
      'delete-data': 'pending',
      'delete-keys': 'pending',
      restart: 'pending',
    });
    expect(calls.map((c) => c.args[2])).toEqual(['stop']);
    expect(fs.existsSync(path.join(dataRoot, 'twenty', 'db', 'f'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'instances', 'main.json'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'secrets', 'main.key_rw'))).toBe(true);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('TWENTY_PASSWORD=secret\n');
    expect(pendingChanges()).toEqual(['Turn off this Mac’s Twenty: agents drop crm-main and keep crm-work']);
  });

  it('is refused once a delete step has started', async () => {
    const images = held<{ removed: string[]; kept: string[] }>();
    const { deps, state } = fakeDeps({
      stackRoot: root,
      // In memory: real file I/O doesn't advance with the fake timers this test steps by.
      files: createFakeStackFiles(),
      removeImages: vi.fn(() => images.promise),
    });
    state.config = JSON.stringify({ services: { 'twenty-server': { image: 'twentycrm/twenty:v2.55.0' } } });
    const installer = createAddonInstaller(deps);
    const done = installer.remove('twenty', { deleteImages: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(installer.snapshot())['delete-images']).toBe('running');

    expect(() => installer.cancel('twenty')).toThrow('Nothing here can be cancelled now.');
    images.release({ removed: ['twentycrm/twenty:v2.55.0'], kept: [] });
    await done;
    expect(installer.snapshot()?.done).toBe(true);
    expect(installer.snapshot()?.cancelled).toBeUndefined();
  });
});
