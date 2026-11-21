import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUR, HOSTED_ONLY, OFF, ON, fakeDeps, okFit, pending, scriptRuns, statuses } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import { ADDON_PYTHON3_MESSAGE, createAddonInstaller, type AddonInstallSnapshot } from '../addonInstaller';
import { parseEnv } from '../../assistant/stackEnv';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { LOCAL_SETTINGS, WORK_SETTINGS, readTwentyWorkspace, writeTwentyWorkspace, twentyWorkspacesDir } from './twentyStoreFixtures';

const OWNER_ENV = { TWENTY_OWNER_FIRST_NAME: 'Ada', TWENTY_OWNER_LAST_NAME: 'Lovelace' };

describe('addon installer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pending.list = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('access choice', () => {
    let tmp: string;
    let root: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-access-'));
      root = path.join(tmp, 'root');
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const store = () => twentyWorkspacesDir(root);

    it('writes the access setting before the restart step waits, with no pending line', async () => {
      const { deps, sh } = fakeDeps({ stackRoot: root });
      let atSetupEnd: Record<string, unknown> = {};
      sh.onInit = () => writeTwentyWorkspace(store(), 'main', LOCAL_SETTINGS, { keyRo: 'r', keyRw: 'w' });
      const installer = createAddonInstaller(deps);
      installer.onChange((s) => {
        if (s.steps.find((step) => step.id === 'restart')?.status === 'waiting') {
          atSetupEnd = readTwentyWorkspace(store(), 'main');
        }
      });
      await installer.install('twenty', { access: 'read' });
      expect(atSetupEnd).toMatchObject({ access: 'read' });
      expect(installer.snapshot()?.error).toBeUndefined();
      expect(pending.list).toEqual([]);
    });

    it('fails the setup step with a readable message when the workspace has no key for the choice', async () => {
      const { deps, sh } = fakeDeps({ stackRoot: root });
      sh.onInit = () => writeTwentyWorkspace(store(), 'main', LOCAL_SETTINGS, { keyRw: 'w' });
      const installer = createAddonInstaller(deps);
      await installer.install('twenty', { access: 'read' });
      const error = installer.snapshot()?.error;
      expect(error?.step).toBe('setup');
      expect(error?.message).toContain('crm-main has no read-only key');
    });
  });

  it('turns the local instance on through addon.sh, runs the steps in order and waits at restart', async () => {
    const { deps, calls, sh } = fakeDeps();
    sh.pullLines = [{ phase: 'pull', service: 'twenty-server', current: 1, total: 2 }];
    const installer = createAddonInstaller(deps);
    const seen: string[] = [];
    installer.onChange((s) => {
      const running = s.steps.find((step) => step.status === 'running');
      if (running && seen.at(-1) !== running.id) seen.push(running.id);
    });

    await installer.install('twenty');

    expect(seen).toEqual(['check', 'download', 'start', 'answer', 'setup']);
    expect(statuses(installer.snapshot())).toEqual({
      check: 'done',
      download: 'done',
      start: 'done',
      answer: 'done',
      setup: 'done',
      restart: 'waiting',
    });
    expect(installer.snapshot()?.done).toBe(false);
    expect(installer.snapshot()?.kind).toBe('install');
    expect(sh.calls.map((c) => c.args)).toEqual([
      ['configure', 'twenty'],
      ['enable', 'twenty', '--reinit', '--json'],
    ]);
    expect(sh.calls[0]?.input).toEqual({ local: true });
    expect(sh.calls[1]?.env).toEqual(OWNER_ENV);
    expect(sh.flags).toEqual(ON);
    expect(calls).toEqual([]);
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', true);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('writes missing Twenty secrets to .env before addon.sh turns the local instance on', async () => {
    // A stack first set up before v0.3.10 has neither; setup.sh is the only thing that makes them.
    const files = createFakeStackFiles({ 'stack:.env': 'TWENTY_MCP_ENABLED=0\n' });
    const { deps, sh } = fakeDeps({ files });
    let atConfigure: Record<string, string> = {};
    const script = vi.mocked(deps.addonScript);
    const base = script.getMockImplementation()!;
    script.mockImplementation(async (args, opts) => {
      if (args[0] === 'configure') atConfigure = parseEnv(files.files.get('stack:.env')!);
      return base(args, opts);
    });

    await createAddonInstaller(deps).install('twenty');

    expect(atConfigure.TWENTY_ENCRYPTION_KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(atConfigure.TWENTY_DB_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(sh.flags).toEqual(ON);
  });

  it('start writes missing Twenty secrets before turning the local instance on', async () => {
    const files = createFakeStackFiles({ 'stack:.env': 'TWENTY_LOCAL_ENABLED=0\n' });
    const { deps } = fakeDeps({ files, isInstalled: vi.fn(async () => true) });

    await createAddonInstaller(deps).start('twenty');

    const env = parseEnv(files.files.get('stack:.env')!);
    expect(env.TWENTY_ENCRYPTION_KEY).toBeTruthy();
    expect(env.TWENTY_DB_PASSWORD).toBeTruthy();
  });

  it('fails the start step, before addon.sh runs, when the secrets can’t be written', async () => {
    const files = createFakeStackFiles({ 'stack:.env': '' });
    files.writeText = vi.fn(async () => {
      throw new Error('EACCES: permission denied');
    });
    const { deps, sh } = fakeDeps({ files });
    const installer = createAddonInstaller(deps);

    await installer.install('twenty');

    expect(installer.snapshot()?.error?.step).toBe('start');
    expect(installer.snapshot()?.error?.message).toMatch(/secrets/);
    expect(sh.calls).toEqual([]);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('shows the init hook’s progress as the setup step’s detail', async () => {
    const { deps } = fakeDeps();
    const installer = createAddonInstaller(deps);
    const details: string[] = [];
    installer.onChange((s) => {
      const detail = s.steps.find((step) => step.id === 'setup')?.detail;
      if (detail && details.at(-1) !== detail) details.push(detail);
    });
    await installer.install('twenty');
    expect(details).toEqual(['owner account']);
    expect(installer.snapshot()?.steps.find((s) => s.id === 'setup')?.detail).toBeUndefined();
  });

  it('reports download bytes from addon.sh pull lines, summed over services', async () => {
    const { deps, sh } = fakeDeps();
    sh.pullLines = [
      { phase: 'pull', service: 'twenty-server', current: 100, total: 1000 },
      { phase: 'pull', service: 'twenty-db', current: 50, total: 500 },
      { phase: 'pull', service: 'twenty-redis' },
    ];
    const installer = createAddonInstaller(deps);
    const bytes: Array<{ done: number; total: number }> = [];
    installer.onChange((s) => {
      const b = s.steps.find((step) => step.id === 'download')?.bytes;
      if (b) bytes.push(b);
    });

    await installer.install('twenty');

    expect(bytes).toContainEqual({ done: 100, total: 1000 });
    expect(bytes).toContainEqual({ done: 150, total: 1500 });
  });

  it('fails the step addon.sh names, with its log tail, and leaves Twenty uninstalled', async () => {
    const { deps, sh } = fakeDeps();
    const tail = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    sh.enableError = { error: 'command_failed', message: 'workspace setup failed', step: 'init', logTail: tail };
    const installer = createAddonInstaller(deps);

    await installer.install('twenty');

    const snap = installer.snapshot();
    expect(statuses(snap).setup).toBe('error');
    expect(statuses(snap).restart).toBe('pending');
    expect(snap?.error).toEqual({
      step: 'setup',
      message: 'Twenty CRM didn’t start: command_failed: workspace setup failed',
      logTail: tail,
    });
    expect(sh.flags).toEqual(OFF);
    expect(deps.setInstalled).not.toHaveBeenCalled();
  });

  it('fails the start step when compose up fails inside enable', async () => {
    const { deps, sh } = fakeDeps();
    sh.enableError = {
      error: 'compose_failed',
      message: 'docker compose up failed: twenty-server exited with an error',
      step: 'start',
      logTail: ['Error: port is already allocated'],
    };
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(installer.snapshot()?.error?.step).toBe('start');
    expect(installer.snapshot()?.error?.logTail).toEqual(['Error: port is already allocated']);
  });

  it('fails the download step when the pull fails', async () => {
    const { deps, sh } = fakeDeps();
    sh.enableError = { error: 'compose_failed', message: 'docker compose pull failed for: twenty-server', step: 'pull', logTail: ['manifest unknown'] };
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(installer.snapshot()?.error).toEqual({
      step: 'download',
      message: 'Twenty CRM didn’t start: compose_failed: docker compose pull failed for: twenty-server',
      logTail: ['manifest unknown'],
    });
  });

  it('fails the download step when configure fails, before enable runs', async () => {
    const { deps, sh } = fakeDeps();
    sh.configureCode = 1;
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(installer.snapshot()?.error?.step).toBe('download');
    expect(installer.snapshot()?.error?.message).toContain('Couldn’t change Twenty CRM’s local setting');
    expect(scriptRuns(sh)).toEqual(['configure:true']);
  });

  it('explains a missing python3', async () => {
    for (const text of [
      'error: python3 not found. Install Python 3.9+ (macOS: xcode-select --install, or brew install python)',
      'error: python3 is missing, a stub, or older than 3.9 (/usr/bin/python3). Install Python 3.9+',
    ]) {
      const { deps, sh } = fakeDeps();
      sh.enableError = { error: 'command_failed', message: 'hook init failed', step: 'init', logTail: ['[crm] starting', text] };
      const installer = createAddonInstaller(deps);
      await installer.install('twenty');
      expect(installer.snapshot()?.error?.message).toBe(ADDON_PYTHON3_MESSAGE);
      expect(installer.snapshot()?.error?.logTail).toContain(text);
    }
    expect(ADDON_PYTHON3_MESSAGE).toBe(
      "Twenty's setup needs Python 3.9 or later on this Mac. Install the Command Line Tools with xcode-select --install, then try again.",
    );
  });

  it('undo turns the local instance off, removes the four containers and leaves data', async () => {
    const { deps, calls, sh } = fakeDeps();
    sh.enableError = { error: 'command_failed', message: 'x', step: 'init', logTail: [] };
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    calls.length = 0;
    sh.calls.length = 0;

    await installer.undo('twenty');

    expect(scriptRuns(sh)).toEqual(['configure:false', 'disable']);
    expect(calls).toEqual([{ args: ['--profile', 'crm', 'rm', '-s', '-f', ...FOUR], env: undefined }]);
    expect(calls.some((c) => c.args.includes('-v') || c.args.includes('down'))).toBe(false);
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(sh.flags).toEqual(OFF);
    expect(sh.local).toBe(false);
    expect(installer.snapshot()).toBeNull();
  });

  it('undo after a failed restart turns Twenty off and reloads Hermes, after removing the containers', async () => {
    const order: string[] = [];
    const reloadHermes = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'Hermes API did not become healthy' })
      .mockImplementation(async () => {
        order.push('reload');
        return { success: true };
      });
    const { deps } = fakeDeps({ reloadHermes });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    await installer.restart('twenty');
    expect(installer.snapshot()?.error?.step).toBe('restart');
    (deps.compose as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      order.push(args[2]);
      return { stdout: '', stderr: '' };
    });
    (deps.setInstalled as ReturnType<typeof vi.fn>).mockImplementation((_id: string, on: boolean) => {
      order.push(`installed:${on}`);
    });

    await installer.undo('twenty');

    expect(order).toEqual(['installed:false', 'rm', 'reload']);
    expect(installer.snapshot()).toBeNull();
  });

  it('undo reloads Hermes when the store says Twenty is installed', async () => {
    const { deps } = fakeDeps({ isInstalled: vi.fn(async () => true) });
    await createAddonInstaller(deps).undo('twenty');
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.reloadHermes).toHaveBeenCalledTimes(1);
  });

  it("undo after a failed setup doesn't reload Hermes", async () => {
    const { deps, sh } = fakeDeps();
    sh.enableError = { error: 'command_failed', message: 'x', step: 'init', logTail: [] };
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    await installer.undo('twenty');
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('undo rejects when the reload fails and reloads again on the next undo', async () => {
    const reloadHermes = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'restart failed' })
      .mockResolvedValueOnce({ success: false, error: 'Hermes API did not become healthy' })
      .mockResolvedValueOnce({ success: true });
    const { deps } = fakeDeps({ reloadHermes });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    await installer.restart('twenty');

    await expect(installer.undo('twenty')).rejects.toThrow('Hermes API did not become healthy');
    expect(installer.snapshot()?.error?.step).toBe('restart');
    await installer.undo('twenty');
    expect(reloadHermes).toHaveBeenCalledTimes(3);
    expect(installer.snapshot()).toBeNull();
  });

  it('turn off runs configure then disable, removes the containers, and leaves the reload for later', async () => {
    const order: string[] = [];
    const { deps, calls, sh } = fakeDeps({
      setInstalled: vi.fn((_id: string, on: boolean) => void order.push(`installed:${on}`)),
    });
    sh.flags = { ...ON };
    sh.local = true;
    (deps.compose as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      order.push(args[2]);
      calls.push({ args });
      return { stdout: '', stderr: '' };
    });
    const installer = createAddonInstaller(deps);

    await installer.turnOff('twenty');

    expect(scriptRuns(sh)).toEqual(['configure:false', 'disable']);
    expect(calls.map((c) => c.args)).toEqual([['--profile', 'crm', 'rm', '-f', ...FOUR]]);
    expect(order).toEqual(['installed:false', 'rm']);
    expect(sh.flags).toEqual(OFF);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
    expect(pending.list).toEqual(['Turn off this Mac’s Twenty: agents drop crm-main']);
  });

  describe('with a hosted workspace stored', () => {
    let tmp: string;
    let root: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-hosted-'));
      root = path.join(tmp, 'root');
      writeTwentyWorkspace(twentyWorkspacesDir(root), 'main', LOCAL_SETTINGS, { keyRw: 'k' });
      writeTwentyWorkspace(twentyWorkspacesDir(root), 'work', WORK_SETTINGS, { keyRw: 'k' });
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('turn off runs enable after configure, so TWENTY_MCP_ENABLED stays 1 and the hosted tools stay', async () => {
      const { deps, sh } = fakeDeps({ stackRoot: root });
      sh.flags = { ...ON };
      sh.local = true;

      await createAddonInstaller(deps).turnOff('twenty');

      expect(sh.calls.map((c) => c.args)).toEqual([
        ['configure', 'twenty'],
        ['enable', 'twenty', '--json'],
      ]);
      expect(sh.calls[0]?.input).toEqual({ local: false });
      expect(sh.flags).toEqual(HOSTED_ONLY);
      expect(pending.list).toEqual(['Turn off this Mac’s Twenty: agents drop crm-main and keep crm-work']);
    });

    it('start after that turn off brings the local instance back', async () => {
      const { deps, sh } = fakeDeps({ stackRoot: root, isInstalled: vi.fn(async () => true) });
      sh.flags = { ...ON };
      sh.local = true;
      const installer = createAddonInstaller(deps);
      await installer.turnOff('twenty');
      await installer.start('twenty');
      expect(sh.flags).toEqual(ON);
      expect(sh.local).toBe(true);
    });
  });

  it('start turns the local instance on through addon.sh and reloads Hermes after it', async () => {
    const order: string[] = [];
    const { deps, calls, sh } = fakeDeps({
      isInstalled: vi.fn(async () => true),
      reloadHermes: vi.fn(async () => {
        order.push('reload');
        return { success: true };
      }),
    });
    const script = vi.mocked(deps.addonScript);
    const base = script.getMockImplementation()!;
    script.mockImplementation(async (args, opts) => {
      order.push(args[0]!);
      return base(args, opts);
    });
    // A Turn off before the stack stored the setting: disable stored local=true.
    sh.local = undefined;
    const installer = createAddonInstaller(deps);
    await installer.start('twenty');

    expect(order).toEqual(['configure', 'enable', 'reload']);
    expect(sh.calls[0]?.input).toEqual({ local: true });
    expect(sh.calls[1]?.args).toEqual(['enable', 'twenty', '--json']);
    expect(sh.calls[1]?.env).toEqual(OWNER_ENV);
    expect(sh.flags).toEqual(ON);
    expect(calls).toEqual([]);
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(installer.snapshot()).toBeNull();
  });

  it('start rejects with addon.sh’s error, and keeps Twenty installed', async () => {
    const { deps, sh } = fakeDeps({ isInstalled: vi.fn(async () => true) });
    sh.enableError = {
      error: 'compose_failed',
      message: 'docker compose up failed: twenty-server exited with an error',
      step: 'start',
      logTail: [],
    };
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow(
      'Twenty CRM didn’t start: compose_failed: docker compose up failed: twenty-server exited with an error'
    );
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('start refuses an add-on that is not installed', async () => {
    const { deps, calls, sh } = fakeDeps();
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow("Twenty CRM isn't installed.");
    expect(calls).toEqual([]);
    expect(sh.calls).toEqual([]);
  });

  it('start rejects when the reload fails', async () => {
    const { deps } = fakeDeps({
      isInstalled: vi.fn(async () => true),
      reloadHermes: vi.fn(async () => ({ success: false, error: 'Hermes API did not become healthy' })),
    });
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow('Hermes API did not become healthy');
  });

  it('turn off leaves the add-on off and rejects when addon.sh fails', async () => {
    const { deps, sh } = fakeDeps();
    sh.disableError = { error: 'busy', message: 'another add-on change is running', step: '', logTail: [] };
    await expect(createAddonInstaller(deps).turnOff('twenty')).rejects.toThrow(
      'Twenty CRM didn’t turn off: busy: another add-on change is running'
    );
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
    expect(deps.compose).not.toHaveBeenCalled();
  });

  it('turn off rejects when removing the containers fails', async () => {
    const { deps } = fakeDeps({
      compose: vi.fn(async () => {
        throw new Error('docker is not running');
      }),
    });
    await expect(createAddonInstaller(deps).turnOff('twenty')).rejects.toThrow('docker is not running');
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
  });

  it('turn off rejects while another add-on operation runs', async () => {
    const { deps, sh } = fakeDeps();
    sh.holdAt = 'start';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(installer.turnOff('twenty')).rejects.toThrow('An add-on install is already running.');
    await expect(installer.remove('twenty', { deleteImages: false })).rejects.toThrow('An add-on install is already running.');
    installer.cancel('twenty');
    await first;
  });

  it('a reloadHermes that throws fails the restart step and allows another restart', async () => {
    const reloadHermes = vi
      .fn()
      .mockRejectedValueOnce(new Error('compose run failed'))
      .mockResolvedValueOnce({ success: true });
    const { deps } = fakeDeps({ reloadHermes });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');

    await installer.restart('twenty');
    expect(statuses(installer.snapshot()).restart).toBe('error');
    expect(installer.snapshot()?.error).toEqual({ step: 'restart', message: 'compose run failed', logTail: [] });

    await installer.restart('twenty');
    expect(statuses(installer.snapshot()).restart).toBe('done');
    expect(installer.snapshot()?.done).toBe(true);
  });

  it('restart reloads Hermes and finishes', async () => {
    const { deps } = fakeDeps();
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    const seen: AddonInstallSnapshot[] = [];
    installer.onChange((s) => seen.push(s));

    await installer.restart('twenty');

    expect(deps.reloadHermes).toHaveBeenCalledTimes(1);
    expect(seen[0] && statuses(seen[0]).restart).toBe('running');
    expect(statuses(installer.snapshot()).restart).toBe('done');
    expect(installer.snapshot()?.done).toBe(true);
  });

  it('shows a failed restart and allows another', async () => {
    const reloadHermes = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'Hermes API did not become healthy' })
      .mockResolvedValueOnce({ success: true });
    const { deps } = fakeDeps({ reloadHermes });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    await installer.restart('twenty');
    expect(installer.snapshot()?.error).toEqual({
      step: 'restart',
      message: 'Hermes API did not become healthy',
      logTail: [],
    });
    await installer.restart('twenty');
    expect(installer.snapshot()?.done).toBe(true);
    expect(installer.snapshot()?.error).toBeUndefined();
  });

  it('refuses a restart when nothing waits for one', async () => {
    const { deps } = fakeDeps();
    const installer = createAddonInstaller(deps);
    await expect(installer.restart('twenty')).rejects.toThrow('Nothing is waiting for a restart.');
  });

  it('refuses to start when the fit verdict is over', async () => {
    const { deps, sh } = fakeDeps({
      checkFit: vi.fn(async () => ({ ...okFit, verdict: 'over' as const, memory: 'over' as const, freeMiB: 1024 })),
    });
    const installer = createAddonInstaller(deps);

    await installer.install('twenty');

    const snap = installer.snapshot();
    expect(statuses(snap).check).toBe('error');
    expect(snap?.error?.step).toBe('check');
    expect(snap?.error?.message).toBe('Twenty CRM needs 2.2 GB of memory. The engine has 1.0 GB free.');
    expect(sh.calls).toEqual([]);
    expect(deps.compose).not.toHaveBeenCalled();
  });

  it('makes room, checks again and installs when asked to', async () => {
    const over = { ...okFit, verdict: 'over' as const, memory: 'over' as const, freeMiB: 1024, suggestedEngineMiB: 8192 };
    const { deps, sh } = fakeDeps({ checkFit: vi.fn().mockResolvedValueOnce(over).mockResolvedValue(okFit) });
    const installer = createAddonInstaller(deps);

    await installer.install('twenty', { makeRoom: true });

    expect(deps.makeRoom).toHaveBeenCalledTimes(1);
    expect(deps.checkFit).toHaveBeenCalledTimes(2);
    expect(statuses(installer.snapshot()).check).toBe('done');
    expect(scriptRuns(sh)).toEqual(['configure:true', 'enable']);
  });

  it('doesn\'t make room unless asked, or when the engine can\'t grow', async () => {
    const over = { ...okFit, verdict: 'over' as const, memory: 'over' as const, freeMiB: 1024 };
    const notAsked = fakeDeps({ checkFit: vi.fn(async () => ({ ...over, suggestedEngineMiB: 8192 })) });
    await createAddonInstaller(notAsked.deps).install('twenty');
    expect(notAsked.deps.makeRoom).not.toHaveBeenCalled();

    const cantGrow = fakeDeps({ checkFit: vi.fn(async () => ({ ...over, suggestedEngineMiB: null })) });
    const installer = createAddonInstaller(cantGrow.deps);
    await installer.install('twenty', { makeRoom: true });
    expect(cantGrow.deps.makeRoom).not.toHaveBeenCalled();
    expect(installer.snapshot()?.error?.step).toBe('check');
  });

  it('fails the check step with the reason when making room fails', async () => {
    const over = { ...okFit, verdict: 'over' as const, memory: 'over' as const, freeMiB: 1024, suggestedEngineMiB: 8192 };
    const { deps, sh } = fakeDeps({
      checkFit: vi.fn(async () => over),
      makeRoom: vi.fn(async () => {
        throw new Error('The engine is back at its old size.');
      }),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty', { makeRoom: true });
    expect(installer.snapshot()?.error?.step).toBe('check');
    expect(installer.snapshot()?.error?.message).toMatch(/back at its old size/);
    expect(sh.calls).toEqual([]);
  });

  it('names the port when it is in use', async () => {
    const { deps } = fakeDeps({
      checkFit: vi.fn(async () => ({ ...okFit, verdict: 'over' as const, port: 'over' as const })),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(installer.snapshot()?.error?.message).toBe(
      'Another program is using port 3000. Stop it, then try again.',
    );
  });

  it('runs a tight fit', async () => {
    const { deps } = fakeDeps({
      checkFit: vi.fn(async () => ({ ...okFit, verdict: 'tight' as const, memory: 'tight' as const })),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
  });

  it('asks checkFit for the add-on it installs', async () => {
    const { deps } = fakeDeps();
    await createAddonInstaller(deps).install('twenty');
    expect(deps.checkFit).toHaveBeenCalledWith('twenty');
  });

  it('rejects a second install while one runs', async () => {
    const { deps, sh } = fakeDeps();
    sh.holdAt = 'start';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(installer.install('twenty')).rejects.toThrow('An add-on install is already running.');
    await expect(installer.undo('twenty')).rejects.toThrow('An add-on install is already running.');
    installer.cancel('twenty');
    await first;
    sh.holdAt = null;
    // Try again after the first finishes is allowed.
    await expect(installer.install('twenty')).resolves.toBeUndefined();
  });

  it('starts over on Try again after a failure', async () => {
    const { deps, sh } = fakeDeps();
    sh.enableError = { error: 'command_failed', message: 'x', step: 'init', logTail: [] };
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    sh.enableError = null;
    await installer.install('twenty');
    expect(installer.snapshot()?.error).toBeUndefined();
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
    expect(sh.flags).toEqual(ON);
  });

  it('stops calling a listener after it unsubscribes', async () => {
    const { deps } = fakeDeps();
    const installer = createAddonInstaller(deps);
    const cb = vi.fn();
    const off = installer.onChange(cb);
    off();
    await installer.install('twenty');
    expect(cb).not.toHaveBeenCalled();
  });
});
