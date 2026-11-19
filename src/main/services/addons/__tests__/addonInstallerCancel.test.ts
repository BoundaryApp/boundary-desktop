import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingChanges } from '../pendingRestart';
import { FOUR, OFF, fakeDeps, pending, statuses } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import { createAddonInstaller } from '../addonInstaller';
import { twentyWorkspacesDir } from '../twentyWorkspaces';
import { LOCAL_SETTINGS, WORK_SETTINGS, writeTwentyWorkspace } from './twentyStoreFixtures';

/** A promise and the function that settles it, for holding a fake call open. */
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Resolves with `value` once `signal` aborts. */
const onAbort = <T>(signal: AbortSignal | undefined, value: T) =>
  new Promise<T>((resolve) => signal?.addEventListener('abort', () => resolve(value), { once: true }));

const RM_ALL = ['--profile', 'crm', 'rm', '-s', '-f', ...FOUR];

describe('cancelling an install', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pending.list = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('during the download stops the pull and changes nothing else', async () => {
    let pullSignal: AbortSignal | undefined;
    const { deps, calls } = fakeDeps({
      composeStreaming: vi.fn((_args: string[], _onLine: (l: string) => void, _env?: NodeJS.ProcessEnv, signal?: AbortSignal) => {
        pullSignal = signal;
        return onAbort(signal, { code: 130 });
      }),
    });
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(installer.snapshot()).download).toBe('running');

    installer.cancel('twenty');
    expect(installer.snapshot()?.cancelling).toBe(true);
    expect(pullSignal?.aborted).toBe(true);
    await done;

    const snap = installer.snapshot();
    expect(snap?.cancelled).toBe(true);
    expect(snap?.done).toBe(true);
    expect(snap?.cancelling).toBe(false);
    expect(snap?.error).toBeUndefined();
    expect(statuses(snap)).toMatchObject({ check: 'done', download: 'cancelled', start: 'pending' });
    expect(calls).toEqual([]);
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(deps.syncStackFlags).not.toHaveBeenCalled();
  });

  it('while waiting for health stops polling at once and removes the containers', async () => {
    const { deps, calls, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statuses(installer.snapshot()).answer).toBe('running');

    installer.cancel('twenty');
    // No timers advance: the 2 s pause between polls ends on the cancel.
    await done;

    const snap = installer.snapshot();
    expect(snap?.cancelled).toBe(true);
    expect(statuses(snap)).toMatchObject({ start: 'done', answer: 'cancelled', setup: 'pending' });
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(deps.runSetup).not.toHaveBeenCalled();
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', OFF);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('during compose up aborts it and removes whatever it created', async () => {
    const { deps, calls } = fakeDeps();
    const compose = vi.mocked(deps.compose);
    const base = compose.getMockImplementation()!;
    let upSignal: AbortSignal | undefined;
    compose.mockImplementation(async (args: string[], opts?: { env?: NodeJS.ProcessEnv; signal?: AbortSignal }) => {
      if (args.includes('up')) {
        upSignal = opts?.signal;
        calls.push({ args });
        await onAbort(opts?.signal, null);
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return base(args, opts);
    });
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(installer.snapshot()).start).toBe('running');

    installer.cancel('twenty');
    await done;
    expect(upSignal?.aborted).toBe(true);
    expect(installer.snapshot()?.cancelled).toBe(true);
    expect(statuses(installer.snapshot()).start).toBe('cancelled');
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
  });

  it('during setup stops crm.sh and removes the containers', async () => {
    let setupSignal: AbortSignal | undefined;
    const { deps, calls } = fakeDeps({
      runSetup: vi.fn((_onLine: (l: string) => void, opts: { signal?: AbortSignal }) => {
        setupSignal = opts.signal;
        return onAbort(opts.signal, { code: 130 });
      }),
    });
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(installer.snapshot()).setup).toBe('running');

    installer.cancel('twenty');
    await done;
    expect(setupSignal?.aborted).toBe(true);
    const snap = installer.snapshot();
    expect(snap?.cancelled).toBe(true);
    expect(snap?.error).toBeUndefined();
    expect(statuses(snap)).toMatchObject({ setup: 'cancelled', restart: 'pending' });
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('while the flags are written after setup still rolls back and writes them off again', async () => {
    const ref: { installer?: ReturnType<typeof createAddonInstaller> } = {};
    const { deps, calls } = fakeDeps({
      syncStackFlags: vi.fn(async (_id: string, flags: Record<string, string>) => {
        if (flags.TWENTY_LOCAL_ENABLED === '1') ref.installer?.cancel('twenty');
      }),
    });
    const installer = createAddonInstaller(deps);
    ref.installer = installer;
    await installer.install('twenty');

    expect(installer.snapshot()?.cancelled).toBe(true);
    expect(statuses(installer.snapshot()).restart).toBe('pending');
    expect(calls.at(-1)?.args).toEqual(RM_ALL);
    expect(deps.syncStackFlags).toHaveBeenLastCalledWith('twenty', OFF);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('records a failure with Undo install still to do when the containers can’t be removed', async () => {
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const compose = vi.mocked(deps.compose);
    const base = compose.getMockImplementation()!;
    compose.mockImplementation(async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (args.includes('rm')) throw Object.assign(new Error('rm failed'), { stderr: 'Error response from daemon' });
      return base(args, opts);
    });
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(3_000);
    installer.cancel('twenty');
    await done;

    const snap = installer.snapshot();
    expect(snap?.cancelled).toBeFalsy();
    expect(snap?.cancelling).toBe(false);
    expect(snap?.error).toEqual({
      step: 'answer',
      message: "Cancelled, but Twenty CRM's containers couldn't be removed.",
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
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(3_000);
    installer.cancel('twenty');
    await first;

    state.serverHealth = 'healthy';
    await installer.install('twenty');
    expect(installer.snapshot()?.cancelled).toBeUndefined();
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
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
    dataRoot = path.join(tmp, 'data');
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
    const { deps, calls } = fakeDeps({ stackPaths: () => ({ root, dataRoot }), isInstalled: vi.fn(() => true) });
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
      stackPaths: () => ({ root, dataRoot }),
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
