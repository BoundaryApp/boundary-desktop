import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOUR, OFF, ON, fakeDeps, okFit, pending, psRow, statuses } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import { ADDON_PYTHON3_MESSAGE, createAddonInstaller, type AddonInstallSnapshot } from '../addonInstaller';
import { twentyWorkspacesDir } from '../twentyWorkspaces';
import { LOCAL_SETTINGS, readTwentyWorkspace, writeTwentyWorkspace } from './twentyStoreFixtures';

const INSTALL_ENV = { TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' };
const SETUP_ENV = { ...INSTALL_ENV, TWENTY_OWNER_FIRST_NAME: 'Ada', TWENTY_OWNER_LAST_NAME: 'Lovelace' };


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
      const { deps } = fakeDeps({ stackPaths: () => ({ root, dataRoot: path.join(tmp, 'data') }) });
      let atSetupEnd: Record<string, unknown> = {};
      deps.runSetup = vi.fn(async () => {
        writeTwentyWorkspace(store(), 'main', LOCAL_SETTINGS, { keyRo: 'r', keyRw: 'w' });
        return { code: 0 };
      });
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
      const { deps } = fakeDeps({ stackPaths: () => ({ root, dataRoot: path.join(tmp, 'data') }) });
      deps.runSetup = vi.fn(async () => {
        writeTwentyWorkspace(store(), 'main', LOCAL_SETTINGS, { keyRw: 'w' });
        return { code: 0 };
      });
      const installer = createAddonInstaller(deps);
      await installer.install('twenty', { access: 'read' });
      const error = installer.snapshot()?.error;
      expect(error?.step).toBe('setup');
      expect(error?.message).toContain('crm-main has no read-only key');
    });
  });

  it('runs the steps in order and waits at restart', async () => {
    const { deps, calls, streamCalls } = fakeDeps();
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
    expect(streamCalls[0].args).toEqual(['--progress', 'json', '--profile', 'crm', 'pull', ...FOUR]);
    expect(streamCalls[0].env).toEqual(INSTALL_ENV);
    expect(calls[0].args).toEqual(['--profile', 'crm', 'up', '-d', ...FOUR]);
    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(['--profile', 'crm']);
      expect(call.env).toEqual(INSTALL_ENV);
    }
    expect(deps.runSetup).toHaveBeenCalledWith(expect.any(Function), {
      env: SETUP_ENV,
      profiles: ['crm'],
      signal: expect.any(AbortSignal),
    });
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', true);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', ON);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('records the flags in the stack before marking Twenty installed', async () => {
    const order: string[] = [];
    const { deps } = fakeDeps({
      syncStackFlags: vi.fn(async (_id: string, flags: Record<string, string>) => {
        order.push(`flags:${flags.TWENTY_LOCAL_ENABLED}`);
      }),
      setInstalled: vi.fn((_id: string, on: boolean) => void order.push(`installed:${on}`)),
    });
    await createAddonInstaller(deps).install('twenty');
    expect(order).toEqual(['flags:1', 'installed:true']);
  });

  it('fails setup and leaves Twenty uninstalled when the flags cannot be written', async () => {
    const { deps } = fakeDeps({
      syncStackFlags: vi.fn(async () => {
        throw new Error("The stack's sync-profiles.sh exited with code 1: rag is on but NEO4J_PASSWORD not set");
      }),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    const snap = installer.snapshot();
    expect(snap?.error?.step).toBe('setup');
    expect(snap?.error?.message).toBe("Twenty CRM is set up, but the stack's .env couldn't record it as on.");
    expect(snap?.error?.logTail.join(' ')).toContain('NEO4J_PASSWORD');
    expect(deps.setInstalled).not.toHaveBeenCalled();
  });

  it('reports download bytes from compose JSON lines', async () => {
    const { deps } = fakeDeps({
      composeStreaming: vi.fn(async (_args: string[], onLine: (l: string) => void) => {
        onLine('{"id":"aa11","parent_id":"twentycrm/twenty:v2.55.0","text":"Downloading","current":100,"total":1000}');
        onLine('{"id":"bb22","parent_id":"postgres:16","text":"Downloading","current":50,"total":500}');
        onLine('not json');
        return { code: 0 };
      }),
    });
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

  it('stops at setup with the log tail when crm.sh exits 1', async () => {
    const { deps, state } = fakeDeps();
    state.setupCode = 1;
    state.setupLines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const installer = createAddonInstaller(deps);

    await installer.install('twenty');

    const snap = installer.snapshot();
    expect(statuses(snap).setup).toBe('error');
    expect(statuses(snap).restart).toBe('pending');
    expect(snap?.error?.step).toBe('setup');
    expect(snap?.error?.message).toBe("Twenty CRM's first-time setup exited with code 1.");
    expect(snap?.error?.logTail).toHaveLength(20);
    expect(snap?.error?.logTail[0]).toBe('line 6');
    expect(snap?.error?.logTail.at(-1)).toBe('line 25');
    expect(deps.setInstalled).not.toHaveBeenCalled();
  });

  it('explains a missing python3', async () => {
    for (const text of [
      'error: python3 not found. Install Python 3.9+ (macOS: xcode-select --install, or brew install python)',
      'error: python3 is missing, a stub, or older than 3.9 (/usr/bin/python3). Install Python 3.9+',
    ]) {
      const { deps, state } = fakeDeps();
      state.setupCode = 1;
      state.setupLines = ['[crm] starting', text];
      const installer = createAddonInstaller(deps);
      await installer.install('twenty');
      expect(installer.snapshot()?.error?.message).toBe(ADDON_PYTHON3_MESSAGE);
      expect(installer.snapshot()?.error?.logTail).toContain(text);
    }
    expect(ADDON_PYTHON3_MESSAGE).toBe(
      "Twenty's setup needs Python 3.9 or later on this Mac. Install the Command Line Tools with xcode-select --install, then try again.",
    );
  });

  it('gives up on a server that never turns healthy after 300 s', async () => {
    const { deps, calls, state } = fakeDeps();
    state.serverHealth = 'starting';
    state.serverLogs = 'twenty-server  | Running migrations\ntwenty-server  | still migrating\n';
    const installer = createAddonInstaller(deps);

    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(298_000);
    expect(statuses(installer.snapshot()).answer).toBe('running');
    await vi.advanceTimersByTimeAsync(4_000);
    await done;

    const snap = installer.snapshot();
    expect(statuses(snap).answer).toBe('error');
    expect(snap?.error?.step).toBe('answer');
    expect(snap?.error?.message).toBe("twenty-server didn't report healthy within 5 minutes.");
    expect(snap?.error?.logTail).toEqual(['twenty-server  | Running migrations', 'twenty-server  | still migrating']);
    expect(calls.at(-1)?.args).toEqual(['--profile', 'crm', 'logs', '--no-color', '--tail', '20', 'twenty-server']);
    const polls = calls.filter((c) => c.args.includes('ps'));
    expect(polls.length).toBeGreaterThanOrEqual(150);
    expect(polls[0].args).toEqual(['--profile', 'crm', 'ps', '--format', 'json', 'twenty-server']);
    expect(deps.runSetup).not.toHaveBeenCalled();
    expect(deps.setInstalled).not.toHaveBeenCalled();
  });

  it('keeps polling until the server turns healthy', async () => {
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(10_000);
    state.serverHealth = 'healthy';
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(statuses(installer.snapshot()).answer).toBe('done');
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
  });

  it("doesn't count unhealthy as healthy", async () => {
    const { deps, state } = fakeDeps();
    state.serverHealth = 'unhealthy';
    const installer = createAddonInstaller(deps);
    const done = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(302_000);
    await done;
    expect(installer.snapshot()?.error?.step).toBe('answer');
    // No server logs: the last ps output stands in.
    expect(installer.snapshot()?.error?.logTail).toEqual([psRow('unhealthy')]);
  });

  it('stops at start with the compose output when up fails', async () => {
    const { deps } = fakeDeps({
      compose: vi.fn(async () => {
        throw Object.assign(new Error('Command failed'), { stderr: 'Error: port is already allocated\n' });
      }),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    const snap = installer.snapshot();
    expect(snap?.error?.step).toBe('start');
    expect(snap?.error?.logTail).toEqual(['Error: port is already allocated']);
    expect(deps.runSetup).not.toHaveBeenCalled();
  });

  it('stops at download when the pull exits non-zero', async () => {
    const { deps } = fakeDeps({
      composeStreaming: vi.fn(async (_a: string[], onLine: (l: string) => void) => {
        onLine('Error response from daemon: manifest unknown');
        return { code: 18 };
      }),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    const snap = installer.snapshot();
    expect(snap?.error).toEqual({
      step: 'download',
      message: 'The download stopped with exit code 18.',
      logTail: ['Error response from daemon: manifest unknown'],
    });
    expect(deps.compose).not.toHaveBeenCalled();
  });

  it('undo removes the four containers and leaves data', async () => {
    const { deps, calls, state } = fakeDeps();
    state.setupCode = 1;
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    calls.length = 0;

    await installer.undo('twenty');

    expect(calls).toEqual([{ args: ['--profile', 'crm', 'rm', '-s', '-f', ...FOUR], env: INSTALL_ENV }]);
    expect(calls.some((c) => c.args.includes('-v') || c.args.includes('down'))).toBe(false);
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', OFF);
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

    expect(order).toEqual(['rm', 'installed:false', 'reload']);
    expect(installer.snapshot()).toBeNull();
  });

  it('undo reloads Hermes when the store says Twenty is installed', async () => {
    const { deps } = fakeDeps({ isInstalled: vi.fn(() => true) });
    await createAddonInstaller(deps).undo('twenty');
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.reloadHermes).toHaveBeenCalledTimes(1);
  });

  it("undo after a failed setup doesn't reload Hermes", async () => {
    const { deps, state } = fakeDeps();
    state.setupCode = 1;
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

  it('turn off keeps data, stops and removes the containers, and leaves the reload for later', async () => {
    const order: string[] = [];
    const { deps, calls } = fakeDeps({
      setInstalled: vi.fn((_id: string, on: boolean) => void order.push(`installed:${on}`)),
    });
    (deps.compose as ReturnType<typeof vi.fn>).mockImplementation(async (args: string[]) => {
      order.push(args[2]);
      calls.push({ args });
      return { stdout: '', stderr: '' };
    });
    const installer = createAddonInstaller(deps);

    await installer.turnOff('twenty');

    expect(calls.map((c) => c.args)).toEqual([
      ['--profile', 'crm', 'stop', ...FOUR],
      ['--profile', 'crm', 'rm', '-f', ...FOUR],
    ]);
    expect(calls.some((c) => c.args.includes('-v') || c.args.includes('down'))).toBe(false);
    expect(order).toEqual(['installed:false', 'stop', 'rm']);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', OFF);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('start brings up the four containers, waits for health and reloads Hermes', async () => {
    const order: string[] = [];
    const { deps, calls, state } = fakeDeps({
      isInstalled: vi.fn(() => true),
      syncStackFlags: vi.fn(async (_id: string, flags: Record<string, string>) => {
        order.push(`flags:${flags.TWENTY_LOCAL_ENABLED}${flags.TWENTY_MCP_ENABLED}`);
      }),
      reloadHermes: vi.fn(async () => {
        order.push('reload');
        return { success: true };
      }),
    });
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const started = installer.start('twenty');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
    state.serverHealth = 'healthy';
    await vi.advanceTimersByTimeAsync(2_000);
    await started;

    expect(calls[0]).toEqual({ args: ['--profile', 'crm', 'up', '-d', ...FOUR], env: INSTALL_ENV });
    expect(order).toEqual(['flags:11', 'reload']);
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(installer.snapshot()).toBeNull();
  });

  it('start rejects with compose output when up fails, and keeps Twenty installed', async () => {
    const { deps } = fakeDeps({
      isInstalled: vi.fn(() => true),
      compose: vi.fn(async () => {
        throw Object.assign(new Error('exit 1'), { stderr: 'Error: port 3000 is already allocated' });
      }),
    });
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow(
      "Twenty CRM's containers didn't start. Error: port 3000 is already allocated"
    );
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('start gives up on a server that stays unhealthy for 300 s', async () => {
    const { deps, state } = fakeDeps({ isInstalled: vi.fn(() => true) });
    state.serverHealth = 'unhealthy';
    const started = createAddonInstaller(deps).start('twenty');
    const settled = expect(started).rejects.toThrow("twenty-server didn't report healthy within 5 minutes.");
    await vi.advanceTimersByTimeAsync(302_000);
    await settled;
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it('start refuses an add-on that is not installed', async () => {
    const { deps, calls } = fakeDeps();
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow("Twenty CRM isn't installed.");
    expect(calls).toEqual([]);
    expect(deps.syncStackFlags).not.toHaveBeenCalled();
  });

  it('start rejects when the reload fails', async () => {
    const { deps } = fakeDeps({
      isInstalled: vi.fn(() => true),
      reloadHermes: vi.fn(async () => ({ success: false, error: 'Hermes API did not become healthy' })),
    });
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow('Hermes API did not become healthy');
  });

  it('turn off leaves the add-on off and rejects when a step fails', async () => {
    const { deps } = fakeDeps({
      compose: vi.fn(async () => {
        throw new Error('docker is not running');
      }),
    });
    await expect(createAddonInstaller(deps).turnOff('twenty')).rejects.toThrow('docker is not running');
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('turn off rejects while another add-on operation runs', async () => {
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(installer.turnOff('twenty')).rejects.toThrow('An add-on install is already running.');
    await expect(installer.remove('twenty', { deleteImages: false })).rejects.toThrow('An add-on install is already running.');
    state.serverHealth = 'healthy';
    await vi.advanceTimersByTimeAsync(2_000);
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
    const { deps } = fakeDeps({
      checkFit: vi.fn(async () => ({ ...okFit, verdict: 'over' as const, memory: 'over' as const, freeMiB: 1024 })),
    });
    const installer = createAddonInstaller(deps);

    await installer.install('twenty');

    const snap = installer.snapshot();
    expect(statuses(snap).check).toBe('error');
    expect(snap?.error?.step).toBe('check');
    expect(snap?.error?.message).toBe('Twenty CRM needs 2.2 GB of memory. The engine has 1.0 GB free.');
    expect(deps.composeStreaming).not.toHaveBeenCalled();
    expect(deps.compose).not.toHaveBeenCalled();
  });

  it('makes room, checks again and installs when asked to', async () => {
    const over = { ...okFit, verdict: 'over' as const, memory: 'over' as const, freeMiB: 1024, suggestedEngineMiB: 8192 };
    const { deps } = fakeDeps({ checkFit: vi.fn().mockResolvedValueOnce(over).mockResolvedValue(okFit) });
    const installer = createAddonInstaller(deps);

    await installer.install('twenty', { makeRoom: true });

    expect(deps.makeRoom).toHaveBeenCalledTimes(1);
    expect(deps.checkFit).toHaveBeenCalledTimes(2);
    expect(statuses(installer.snapshot()).check).toBe('done');
    expect(deps.composeStreaming).toHaveBeenCalled();
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
    const { deps } = fakeDeps({
      checkFit: vi.fn(async () => over),
      makeRoom: vi.fn(async () => {
        throw new Error('The engine is back at its old size.');
      }),
    });
    const installer = createAddonInstaller(deps);
    await installer.install('twenty', { makeRoom: true });
    expect(installer.snapshot()?.error?.step).toBe('check');
    expect(installer.snapshot()?.error?.message).toMatch(/back at its old size/);
    expect(deps.composeStreaming).not.toHaveBeenCalled();
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
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(installer.install('twenty')).rejects.toThrow('An add-on install is already running.');
    await expect(installer.undo('twenty')).rejects.toThrow('An add-on install is already running.');
    state.serverHealth = 'healthy';
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    // Try again after the first finishes is allowed.
    await expect(installer.install('twenty')).resolves.toBeUndefined();
  });

  it('starts over on Try again after a failure', async () => {
    const { deps, state } = fakeDeps();
    state.setupCode = 1;
    const installer = createAddonInstaller(deps);
    await installer.install('twenty');
    state.setupCode = 0;
    await installer.install('twenty');
    expect(installer.snapshot()?.error).toBeUndefined();
    expect(statuses(installer.snapshot()).restart).toBe('waiting');
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
