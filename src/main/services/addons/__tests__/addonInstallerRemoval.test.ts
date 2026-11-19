import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingChanges } from '../pendingRestart';
import { FOUR, fakeDeps, pending, statuses } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import { createAddonInstaller, type AddonInstallSnapshot, type AddonInstallerDeps } from '../addonInstaller';
import { twentyWorkspacesDir } from '../twentyWorkspaces';
import { LOCAL_SETTINGS, WORK_SETTINGS, writeTwentyWorkspace } from './twentyStoreFixtures';

describe('addon removal', () => {
  let tmp: string;
  let root: string;
  let dataRoot: string;
  let wsDir: string;
  const envText = '# stack env\nFOO=1\nexport TWENTY_USERNAME=owner@crm.localhost\n  TWENTY_PASSWORD = secret\nTWENTY_PASSWORD_HINT=keep\nTWENTY_PORT=3000\nBAR=2\n';
  const envAfter = '# stack env\nFOO=1\nTWENTY_PASSWORD_HINT=keep\nTWENTY_PORT=3000\nBAR=2\n';
  const CONFIG = JSON.stringify({
    services: {
      'twenty-db': { image: 'postgres:16' },
      'twenty-redis': { image: 'redis:7' },
      'twenty-server': { image: 'twentycrm/twenty:v2.55.0' },
      'twenty-worker': { image: 'twentycrm/twenty:v2.55.0' },
      hermes: { image: 'hermes:1' },
    },
  });
  const ws = (name: string) => path.join(wsDir, name);

  beforeEach(() => {
    vi.useFakeTimers();
    pending.list = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-remove-'));
    root = path.join(tmp, 'root');
    dataRoot = path.join(tmp, 'data');
    wsDir = twentyWorkspacesDir(root);
    fs.mkdirSync(path.join(dataRoot, 'twenty', 'db'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'twenty', 'db', 'f'), 'x');
    writeTwentyWorkspace(wsDir, 'main', LOCAL_SETTINGS, { keyRo: 'r', keyRw: 'k' });
    writeTwentyWorkspace(wsDir, 'work', WORK_SETTINGS, { keyRw: 'k' });
    fs.writeFileSync(path.join(root, '.env'), envText);
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.chmodSync(dataRoot, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const setup = (overrides: Partial<AddonInstallerDeps> = {}) => {
    const fake = fakeDeps({ stackPaths: () => ({ root, dataRoot }), ...overrides });
    fake.state.config = CONFIG;
    return { ...fake, installer: createAddonInstaller(fake.deps) };
  };
  const ids = (s: AddonInstallSnapshot | null) => (s?.steps ?? []).map((step) => step.id);

  it('while installed, stops, removes, deletes and waits at restart', async () => {
    const { installer, deps, calls } = setup({ isInstalled: vi.fn(() => true) });
    await installer.remove('twenty', { deleteImages: false });

    const snap = installer.snapshot();
    expect(snap?.kind).toBe('remove');
    expect(ids(snap)).toEqual(['stop', 'remove-containers', 'delete-data', 'delete-keys', 'restart']);
    expect(statuses(snap)).toEqual({
      stop: 'done',
      'remove-containers': 'done',
      'delete-data': 'done',
      'delete-keys': 'done',
      restart: 'waiting',
    });
    expect(snap?.done).toBe(false);
    expect(snap?.error).toBeUndefined();
    expect(calls.map((c) => c.args)).toEqual([
      ['--profile', 'crm', 'stop', ...FOUR],
      ['--profile', 'crm', 'rm', '-f', ...FOUR],
    ]);
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    // crm-work is a stored hosted workspace, so its tools stay.
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' });
    expect(deps.reloadHermes).not.toHaveBeenCalled();
    expect(deps.removeImages).not.toHaveBeenCalled();

    await installer.restart('twenty');
    expect(deps.reloadHermes).toHaveBeenCalledTimes(1);
    expect(statuses(installer.snapshot()).restart).toBe('done');
    expect(installer.snapshot()?.done).toBe(true);
  });

  it('adds delete-images before restart when asked', async () => {
    const { installer } = setup({ isInstalled: vi.fn(() => true) });
    await installer.remove('twenty', { deleteImages: true });
    expect(ids(installer.snapshot())).toEqual([
      'stop',
      'remove-containers',
      'delete-data',
      'delete-keys',
      'delete-images',
      'restart',
    ]);
    expect(statuses(installer.snapshot())['delete-images']).toBe('done');
  });

  it('records Twenty off before it stops anything', async () => {
    const order: string[] = [];
    const { installer } = setup({
      isInstalled: vi.fn(() => true),
      setInstalled: vi.fn((_id: string, on: boolean) => void order.push(`installed:${on}`)),
      syncStackFlags: vi.fn(async (_id: string, flags: Record<string, string>) => {
        order.push(`flags:${flags.TWENTY_LOCAL_ENABLED}`);
      }),
      compose: vi.fn(async (args: string[]) => {
        order.push(args[2]);
        return { stdout: '', stderr: '' };
      }),
    });
    await installer.remove('twenty', { deleteImages: false });
    expect(order).toEqual(['installed:false', 'flags:0', 'stop', 'rm']);
  });

  it('while off, stops and removes what containers are left, deletes, and ends done with no restart', async () => {
    const { installer, deps, calls } = setup();
    await installer.remove('twenty', { deleteImages: true });

    const snap = installer.snapshot();
    expect(ids(snap)).toEqual(['stop', 'remove-containers', 'delete-data', 'delete-keys', 'delete-images']);
    expect(statuses(snap)).toEqual({
      stop: 'done',
      'remove-containers': 'done',
      'delete-data': 'done',
      'delete-keys': 'done',
      'delete-images': 'done',
    });
    expect(snap?.done).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      ['--profile', 'crm', 'config', '--format', 'json'],
      ['--profile', 'crm', 'stop', ...FOUR],
      ['--profile', 'crm', 'rm', '-f', ...FOUR],
    ]);
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(deps.syncStackFlags).not.toHaveBeenCalled();
    expect(deps.reloadHermes).not.toHaveBeenCalled();
  });

  it("deletes the data folder, the local workspace's settings and keys and the two .env keys; hosted workspaces stay", async () => {
    const { installer } = setup();
    await installer.remove('twenty', { deleteImages: false });

    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(false);
    expect(fs.readdirSync(ws('instances'))).toEqual(['work.json']);
    expect(fs.readdirSync(ws('secrets'))).toEqual(['work.key_rw']);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(envAfter);
  });

  it('keeps a .env without a trailing newline as it was, and missing files are not an error', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'A=1\nTWENTY_PASSWORD=x\nB=2');
    fs.rmSync(wsDir, { recursive: true });
    fs.rmSync(path.join(dataRoot, 'twenty'), { recursive: true });
    const { installer } = setup();
    await installer.remove('twenty', { deleteImages: false });
    expect(installer.snapshot()?.error).toBeUndefined();
    expect(installer.snapshot()?.done).toBe(true);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('A=1\nB=2');
  });

  it('resolves the images from compose config before stopping, and keeps one in use', async () => {
    const { installer, deps, calls } = setup({
      isInstalled: vi.fn(() => true),
      removeImages: vi.fn(async () => ({
        removed: ['redis:7', 'twentycrm/twenty:v2.55.0'],
        kept: ['postgres:16'],
      })),
    });
    await installer.remove('twenty', { deleteImages: true });

    expect(calls[0].args).toEqual(['--profile', 'crm', 'config', '--format', 'json']);
    expect(calls[1].args).toEqual(['--profile', 'crm', 'stop', ...FOUR]);
    expect(deps.removeImages).toHaveBeenCalledWith(['postgres:16', 'redis:7', 'twentycrm/twenty:v2.55.0']);
    const step = installer.snapshot()?.steps.find((s) => s.id === 'delete-images');
    expect(step?.status).toBe('done');
    expect(step?.detail).toContain('postgres:16');
    expect(installer.snapshot()?.error).toBeUndefined();
  });

  it('fails delete-images when compose config gives no images', async () => {
    const { installer, state } = setup();
    state.config = 'not json';
    await installer.remove('twenty', { deleteImages: true });
    const snap = installer.snapshot();
    expect(statuses(snap)).toEqual({
      stop: 'done',
      'remove-containers': 'done',
      'delete-data': 'done',
      'delete-keys': 'done',
      'delete-images': 'error',
    });
    expect(snap?.error?.step).toBe('delete-images');
    expect(snap?.error?.logTail).toEqual(["compose config didn't print the expected JSON."]);
  });

  it('keeps compose config output and parse errors out of the log tail', async () => {
    // A config that parses but names no image, then one that doesn't parse: neither's text shows.
    for (const config of [JSON.stringify({ services: { other: { image: 'SECRET_IMAGE' } } }), '{"TWENTY_PASSWORD": SECRET']) {
      const { installer, state } = setup();
      state.config = config;
      await installer.remove('twenty', { deleteImages: true });
      const error = installer.snapshot()?.error;
      expect(error?.logTail).toEqual(["compose config didn't print the expected JSON."]);
      expect(JSON.stringify(error)).not.toContain('SECRET');
    }
  });

  it('passes only stderr from a compose config that fails', async () => {
    const base = fakeDeps({ stackPaths: () => ({ root, dataRoot }) });
    const compose = base.deps.compose;
    const installer = createAddonInstaller({
      ...base.deps,
      compose: vi.fn(async (args: string[], opts?: { env?: NodeJS.ProcessEnv; timeout?: number }) => {
        if (args.includes('config')) {
          throw Object.assign(new Error('Command failed: compose config\nSECRET_STDOUT'), {
            stdout: 'services:\n  TWENTY_PASSWORD: SECRET_STDOUT',
            stderr: 'invalid interpolation format',
          });
        }
        return compose(args, opts);
      }) as AddonInstallerDeps['compose'],
    });
    await installer.remove('twenty', { deleteImages: true });
    const error = installer.snapshot()?.error;
    expect(error?.step).toBe('delete-images');
    expect(error?.logTail).toEqual(['invalid interpolation format']);
    expect(JSON.stringify(error)).not.toContain('SECRET_STDOUT');
  });

  it('records a delete-data failure with its log tail, leaves Twenty off, and resumes there', async () => {
    const { installer, deps, calls } = setup({ isInstalled: vi.fn(() => true) });
    fs.chmodSync(dataRoot, 0o500);
    await installer.remove('twenty', { deleteImages: false });

    let snap = installer.snapshot();
    expect(statuses(snap)).toEqual({
      stop: 'done',
      'remove-containers': 'done',
      'delete-data': 'error',
      'delete-keys': 'pending',
      restart: 'pending',
    });
    expect(snap?.error?.step).toBe('delete-data');
    expect(snap?.error?.logTail.join(' ')).toMatch(/EACCES|EPERM/);
    expect(deps.setInstalled).toHaveBeenCalledWith('twenty', false);
    expect(deps.setInstalled).not.toHaveBeenCalledWith('twenty', true);
    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(true);

    fs.chmodSync(dataRoot, 0o755);
    const composeCalls = calls.length;
    await installer.remove('twenty', { deleteImages: false });

    snap = installer.snapshot();
    expect(calls.length).toBe(composeCalls);
    expect(snap?.error).toBeUndefined();
    expect(statuses(snap)).toEqual({
      stop: 'done',
      'remove-containers': 'done',
      'delete-data': 'done',
      'delete-keys': 'done',
      restart: 'waiting',
    });
    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(false);
  });

  it('refuses in local stack mode before any step runs', async () => {
    const { installer, deps, calls } = setup({ isInstalled: vi.fn(() => true), isLocalStack: vi.fn(() => true) });
    await expect(installer.remove('twenty', { deleteImages: true })).rejects.toThrow(
      "Remove Twenty's data from the stack checkout instead; Boundary doesn't delete files in a local stack."
    );
    expect(installer.snapshot()).toBeNull();
    expect(calls).toEqual([]);
    expect(deps.setInstalled).not.toHaveBeenCalled();
    expect(deps.syncStackFlags).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(true);
    expect(fs.existsSync(ws('instances/main.json'))).toBe(true);
    expect(fs.existsSync(ws('secrets/main.key_rw'))).toBe(true);
  });

  it('replaces pending lines about crm-main with one for the removal when a run with a restart starts', async () => {
    pending.list = ['Turn off this Mac’s Twenty: agents drop crm-main and keep crm-work', 'Connect crm-work'];
    const { installer } = setup({ isInstalled: vi.fn(() => true) });
    await installer.remove('twenty', { deleteImages: false });
    expect(pendingChanges()).toEqual(['Connect crm-work', 'Remove this Mac’s Twenty: agents drop crm-main']);
    await installer.restart('twenty');
    expect(pendingChanges()).toEqual([]);
  });

  it('keeps a pending line naming crm-main when a step after stop fails', async () => {
    const { installer } = setup({ isInstalled: vi.fn(() => true) });
    fs.chmodSync(dataRoot, 0o500);
    await installer.remove('twenty', { deleteImages: false });
    expect(installer.snapshot()?.error?.step).toBe('delete-data');
    expect(pendingChanges()).toEqual(['Remove this Mac’s Twenty: agents drop crm-main']);
  });

  it('after a relaunch, a resumed removal still stops and removes the containers before deleting', async () => {
    // The first run recorded Twenty off, then its stop failed; the app quit, so its snapshot is gone.
    let installed = true;
    const first = setup({
      isInstalled: vi.fn(() => installed),
      setInstalled: vi.fn((_id: string, on: boolean) => void (installed = on)),
      compose: vi.fn(async (args: string[]) => {
        if (args.includes('stop')) throw Object.assign(new Error('stop failed'), { stderr: 'engine stopped' });
        return { stdout: '', stderr: '' };
      }),
    });
    await first.installer.remove('twenty', { deleteImages: false });
    expect(first.installer.snapshot()?.error?.step).toBe('stop');
    expect(installed).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, 'twenty'))).toBe(true);
    expect(pendingChanges()).toEqual(['Remove this Mac’s Twenty: agents drop crm-main']);

    const order: string[] = [];
    const relaunched = setup({
      isInstalled: vi.fn(() => installed),
      compose: vi.fn(async (args: string[]) => {
        order.push(args[2]);
        return { stdout: '', stderr: '' };
      }),
    });
    const rmSync = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === path.join(dataRoot, 'twenty')) order.push('delete-data');
      return rmSync(p, o);
    }) as typeof fs.rmSync);
    await relaunched.installer.remove('twenty', { deleteImages: false });
    spy.mockRestore();

    expect(ids(relaunched.installer.snapshot())).toEqual(['stop', 'remove-containers', 'delete-data', 'delete-keys']);
    expect(order.slice(0, 3)).toEqual(['stop', 'rm', 'delete-data']);
    expect(relaunched.installer.snapshot()?.done).toBe(true);
    // No restart step in this run; the line the first run wrote still asks for one.
    expect(pendingChanges()).toEqual(['Remove this Mac’s Twenty: agents drop crm-main']);
  });

  it('keeps pending lines about crm-main while off, since no restart step follows', async () => {
    pending.list = ['Turn off this Mac’s Twenty: agents drop crm-main'];
    const { installer } = setup();
    await installer.remove('twenty', { deleteImages: false });
    expect(pendingChanges()).toEqual(['Turn off this Mac’s Twenty: agents drop crm-main']);
  });
});
