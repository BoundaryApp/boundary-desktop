import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';

vi.mock('../../assistant/AssistantStackService', () => ({
  getAssistantStackAccess: vi.fn(),
  reloadHermesForAddons: vi.fn(),
}));
vi.mock('../../assistant/AssistantStackStore', () => ({
  getInstalledAddons: () => [],
  setAddonInstalled: vi.fn(),
}));
vi.mock('../../assistant/localStackMode', () => ({ isLocalAssistantStackMode: vi.fn(() => false) }));
vi.mock('../addonHostFacts', () => ({ readAddonHostFacts: vi.fn() }));

import {
  ADDON_PYTHON3_MESSAGE,
  createAddonInstaller,
  getAddonInstaller,
  runAddonSetupScript,
  type AddonInstallSnapshot,
  type AddonInstallerDeps,
} from '../addonInstaller';

const FAKE_STACK = path.join(os.tmpdir(), 'addon-installer-fake-stack');
const FOUR = ['twenty-db', 'twenty-redis', 'twenty-server', 'twenty-worker'];
const INSTALL_ENV = { TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' };

const okFit: AddonFit = {
  verdict: 'ok',
  memory: 'ok',
  disk: 'ok',
  port: 'ok',
  freeMiB: 6000,
  suggestedEngineMiB: null,
};

function psRow(health: string): string {
  return JSON.stringify({ Service: 'twenty-server', State: 'running', Health: health });
}

type ComposeCall = { args: string[]; env?: NodeJS.ProcessEnv };

/** Stand-ins for compose and crm.sh. `serverHealth` is what `ps` reports for twenty-server. */
function fakeDeps(overrides: Partial<AddonInstallerDeps> = {}) {
  const calls: ComposeCall[] = [];
  const streamCalls: ComposeCall[] = [];
  const state = { serverHealth: 'healthy', serverLogs: '', setupCode: 0, setupLines: [] as string[] };
  const deps: AddonInstallerDeps = {
    checkFit: vi.fn(async () => okFit),
    compose: vi.fn(async (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: opts?.env });
      if (args.includes('ps')) return { stdout: psRow(state.serverHealth), stderr: '' };
      if (args.includes('logs')) return { stdout: state.serverLogs, stderr: '' };
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
    // A per-run temp folder: install creates data/twenty/{db,storage} under dataRoot.
    stackPaths: vi.fn(() => ({ root: FAKE_STACK, dataRoot: path.join(FAKE_STACK, 'data') })),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
  return { deps, calls, streamCalls, state };
}

function statuses(s: AddonInstallSnapshot | null): Record<string, string> {
  return Object.fromEntries((s?.steps ?? []).map((step) => [step.id, step.status]));
}

describe('addon installer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
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
    expect(streamCalls[0].args).toEqual(['--progress', 'json', '--profile', 'crm', 'pull', ...FOUR]);
    expect(streamCalls[0].env).toEqual(INSTALL_ENV);
    expect(calls[0].args).toEqual(['--profile', 'crm', 'up', '-d', ...FOUR]);
    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(['--profile', 'crm']);
      expect(call.env).toEqual(INSTALL_ENV);
    }
    expect(deps.runSetup).toHaveBeenCalledWith(expect.any(Function), {
      env: INSTALL_ENV,
      profiles: ['crm'],
    });
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', true);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
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

  it('turn off keeps data and reloads Hermes', async () => {
    const order: string[] = [];
    const { deps, calls } = fakeDeps({
      setInstalled: vi.fn((_id: string, on: boolean) => void order.push(`installed:${on}`)),
      reloadHermes: vi.fn(async () => {
        order.push('reload');
        return { success: true };
      }),
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
    expect(order).toEqual(['installed:false', 'stop', 'rm', 'reload']);
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

    const reload = fakeDeps({ reloadHermes: vi.fn(async () => ({ success: false, error: 'Hermes API did not become healthy' })) });
    await expect(createAddonInstaller(reload.deps).turnOff('twenty')).rejects.toThrow(
      'Hermes API did not become healthy'
    );
    expect(reload.deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
  });

  it('turn off rejects while another add-on operation runs', async () => {
    const { deps, state } = fakeDeps();
    state.serverHealth = 'starting';
    const installer = createAddonInstaller(deps);
    const first = installer.install('twenty');
    await vi.advanceTimersByTimeAsync(0);
    await expect(installer.turnOff('twenty')).rejects.toThrow('An add-on install is already running.');
    await expect(installer.removeData('twenty')).rejects.toThrow('An add-on install is already running.');
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
    const compose = made.deps.compose as ReturnType<typeof vi.fn>;
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

/** A spawn stand-in that prints `lines` and exits with `code`, or fails to start. */
function fakeSpawn(behaviour: { lines?: string[]; code?: number; fail?: boolean; hang?: boolean }) {
  const calls: Array<{ command: string; args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } }> = [];
  const kills: string[] = [];
  const impl = ((command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, options });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: (signal: string) => {
        kills.push(signal);
        setTimeout(() => child.emit('close', null), 0);
        return true;
      },
    });
    setTimeout(() => {
      if (behaviour.fail) {
        child.emit('error', Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }));
        return;
      }
      const lines = behaviour.lines ?? [];
      stdout.emit('data', Buffer.from(lines.slice(0, 1).map((l) => `${l}\n`).join('')));
      // A line split across two chunks, on stderr.
      const rest = lines.slice(1).join('\n');
      if (rest) {
        stderr.emit('data', Buffer.from(rest.slice(0, 3)));
        stderr.emit('data', Buffer.from(`${rest.slice(3)}\n`));
      }
      if (!behaviour.hang) child.emit('close', behaviour.code ?? 0);
    }, 0);
    return child;
  }) as unknown as typeof spawn;
  return { impl, calls, kills };
}

describe('runAddonSetupScript', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs bash scripts/crm.sh init in the stack root and passes each line on', async () => {
    const { impl, calls } = fakeSpawn({ lines: ['[crm] Generated the owner password', '[crm] Next: make hermes-reload'] });
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
    const { impl } = fakeSpawn({ lines: ['[crm] ERROR: Docker daemon is not running'], code: 1 });
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
});

describe('addon data removal', () => {
  let tmp: string;
  let root: string;
  let dataRoot: string;
  const envText = '# stack env\nFOO=1\nexport TWENTY_USERNAME=owner@crm.localhost\n  TWENTY_PASSWORD = secret\nTWENTY_PASSWORD_HINT=keep\nTWENTY_PORT=3000\nBAR=2\n';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-remove-'));
    root = path.join(tmp, 'root');
    dataRoot = path.join(tmp, 'data');
    fs.mkdirSync(path.join(dataRoot, 'twenty', 'db'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'twenty', 'db', 'f'), 'x');
    fs.mkdirSync(path.join(root, 'compose', 'twenty', 'workspaces'), { recursive: true });
    fs.writeFileSync(path.join(root, 'compose', 'twenty', 'workspaces', 'main.env'), 'TWENTY_KEY_RW=k\n');
    fs.writeFileSync(path.join(root, '.env'), envText);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const make = (overrides: Partial<AddonInstallerDeps> = {}) =>
    createAddonInstaller(fakeDeps({ stackPaths: () => ({ root, dataRoot }), ...overrides }).deps);

  it('remove refuses while Twenty is on', async () => {
    await expect(make({ isInstalled: () => true }).removeData('twenty')).rejects.toThrow(
      'Turn Twenty off before removing its data.'
    );
    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(true);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(envText);
  });

  it('remove refuses in local stack mode', async () => {
    await expect(make({ isLocalStack: () => true }).removeData('twenty')).rejects.toThrow(
      "Remove Twenty's data from the stack checkout instead; Boundary doesn't delete files in a local stack."
    );
    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(true);
  });

  it('remove deletes the data folder, the workspace file and the two .env keys', async () => {
    const { removed } = await make().removeData('twenty');

    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'compose', 'twenty', 'workspaces', 'main.env'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      '# stack env\nFOO=1\nTWENTY_PASSWORD_HINT=keep\nTWENTY_PORT=3000\nBAR=2\n'
    );
    expect(removed).toHaveLength(3);
  });

  it('keeps a .env without a trailing newline as it was', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'A=1\nTWENTY_PASSWORD=x\nB=2');
    await make().removeData('twenty');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=1\nB=2');
  });

  it('missing files are not an error and are not listed', async () => {
    fs.rmSync(path.join(root, '.env'));
    fs.rmSync(path.join(root, 'compose'), { recursive: true });
    const { removed } = await make().removeData('twenty');
    expect(removed).toEqual([path.join(dataRoot, 'twenty')]);

    fs.rmSync(dataRoot, { recursive: true });
    await expect(make().removeData('twenty')).resolves.toEqual({ removed: [] });
  });

  it('leaves a .env without the keys untouched', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
    const { removed } = await make().removeData('twenty');
    expect(removed.some((r) => r.includes('TWENTY_PASSWORD'))).toBe(false);
  });
});
