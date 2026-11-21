import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import type { AddonInstallSnapshot } from '../../../../shared/types/addons';
import { createActualService } from '../actualAddon';
import { actualDataDir, createActualInstaller, type ActualInstaller } from '../actualInstaller';
import { createActualFakeStack, type ActualFakeStack } from './actualFake';

const FITS: AddonFit = { verdict: 'ok', memory: 'ok', disk: 'ok', port: 'ok', freeMiB: 4000, suggestedEngineMiB: null };

let stack: ActualFakeStack;
let installer: ActualInstaller;
let snapshots: AddonInstallSnapshot[];
let fit: AddonFit;
let localStack: boolean;
const removeImages = vi.fn(async (images: string[]) => ({ removed: images, kept: [] as string[] }));

beforeEach(() => {
  stack = createActualFakeStack();
  snapshots = [];
  fit = FITS;
  localStack = false;
  removeImages.mockClear();
  const run = (...args: Parameters<ActualFakeStack['run']>) => stack.run(...args);
  const service = createActualService({
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    files: stack.files,
    run,
    exclusive: (work) => work(),
    log: () => undefined,
  });
  installer = createActualInstaller({
    service,
    run,
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    files: stack.files,
    checkFit: async () => fit,
    isLocalStack: () => localStack,
    images: async () => ['actualbudget/actual-server:26.11.0', 'boundary-actual-mcp:local'],
    removeImages,
    deleteDir: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
    exclusive: (work) => work(),
    log: () => undefined,
  });
  installer.onChange((s) => snapshots.push(s));
});

afterEach(() => stack.cleanup());

const statuses = (s: AddonInstallSnapshot | null) => s?.steps.map((step) => `${step.id}:${step.status}`);
const args = () => stack.calls.map((c) => `${c.script} ${c.args.join(' ')}`);

describe('Get', () => {
  it('turns on this Mac’s server and connects its only budget with Look things up', async () => {
    await installer.install();
    const last = installer.snapshot()!;
    expect(last.done).toBe(true);
    expect(last.error).toBeUndefined();
    expect(statuses(last)).toEqual(['check:done', 'download:done', 'start:done', 'setup:done', 'connect:done']);
    expect(last.steps.find((s) => s.id === 'connect')!.detail).toBe('Agents see it as budget-budget');
    expect(args()).toEqual([
      'addon.sh configure actual',
      'addon.sh enable actual --reinit --json',
      'budget.sh budgets --json',
      'addon.sh connect actual --instance budget --json',
    ]);
    expect(stack.calls[0]!.input).toEqual({ local: true });
    expect(stack.calls[3]!.input).toEqual({ server: 'local', sync_id: 'local-1' });
    // The download step showed the pull's bytes while it ran.
    expect(snapshots.some((s) => s.steps.some((step) => step.id === 'download' && step.bytes?.done === 50))).toBe(true);
  });

  it('connects with Make changes when chosen', async () => {
    await installer.install({ access: 'write' });
    expect(stack.calls.at(-1)!.input).toMatchObject({ bind: { default: 'rw', browser: 'rw', 'api-server': 'ro' } });
  });

  it('leaves the pick to the page when the server has several budgets', async () => {
    stack.servers.local!.budgets.push({ syncId: 'local-2', name: 'Other' });
    await installer.install();
    const connect = installer.snapshot()!.steps.find((s) => s.id === 'connect')!;
    expect(connect).toMatchObject({ status: 'done', detail: 'This Mac’s server has 2 budgets. Pick one to connect.' });
    expect(args()).not.toContain('addon.sh connect actual --instance budget --json');
  });

  it('doesn’t connect again when this Mac’s budget is already connected (Turn on)', async () => {
    stack.addRow('home', { server: 'local', sync_id: 'local-1' });
    await installer.install();
    expect(installer.snapshot()!.steps.find((s) => s.id === 'connect')!.detail).toBe('Already connected as budget-home');
    expect(args().some((a) => a.includes('budgets'))).toBe(false);
  });

  it('picks a free name when the first one is taken', async () => {
    stack.addRow('budget', { server: 'https://budget.example.com', sync_id: 'x' });
    await installer.install();
    expect(args().at(-1)).toBe('addon.sh connect actual --instance budget-2 --json');
  });

  it('stops at the check when it doesn’t fit, before anything changes', async () => {
    fit = { ...FITS, verdict: 'over', memory: 'over' };
    await installer.install();
    expect(installer.snapshot()!.error).toMatchObject({ step: 'check' });
    expect(stack.calls).toEqual([]);
  });

  it('puts enable’s error on the step it names, with its log tail', async () => {
    stack.override = (_s, a) =>
      a[0] === 'enable'
        ? { kind: 'error', error: 'compose_failed', step: 'start', message: 'docker compose up failed', logTail: ['port in use'], lines: [] }
        : null;
    await installer.install();
    const s = installer.snapshot()!;
    expect(s.error).toEqual({ step: 'start', message: 'compose_failed: docker compose up failed', logTail: ['port in use'] });
    expect(s.done).toBe(false);
  });

  it('reports an enable that exits with no done line', async () => {
    stack.override = (_s, a) => (a[0] === 'enable' ? { kind: 'exited', code: 1, logTail: ['killed'], lines: [] } : null);
    await installer.install();
    expect(installer.snapshot()!.error).toMatchObject({ message: 'the script exited with code 1 and no result: killed' });
  });

  it('fails the connect step with the error’s name', async () => {
    stack.override = (_s, a) =>
      a[0] === 'connect' ? { kind: 'error', error: 'login_refused', step: 'check', message: 'the server refused the password', logTail: [], lines: [] } : null;
    await installer.install();
    expect(installer.snapshot()!.error).toMatchObject({
      step: 'connect',
      message: 'Couldn’t connect Budget: login_refused: the server refused the password',
    });
  });

  it('ends cancelled when the run is stopped', async () => {
    let release!: () => void;
    let enableStarted!: () => void;
    const started = new Promise<void>((resolve) => (enableStarted = resolve));
    const original = stack.run.bind(stack);
    stack.run = async (script, a, options) => {
      if (a[0] !== 'enable') return original(script, a, options);
      enableStarted();
      // addon.sh's enable writes the flags back when it's stopped, then exits.
      await new Promise<void>((resolve) => (release = resolve));
      return { kind: 'error', error: 'command_failed', step: 'start', message: 'stopped by SIGTERM', logTail: [], lines: [] };
    };
    const running = installer.install();
    await started;
    installer.cancel();
    release();
    await running;
    expect(installer.snapshot()).toMatchObject({ cancelled: true, done: true });
    expect(installer.snapshot()!.error).toBeUndefined();
  });
});

describe('Connect a budget while Actual is off', () => {
  const remote = {
    server: 'https://budget.example.com',
    sessionToken: 'good-token',
    slug: 'home',
    syncId: 'home-1',
    access: 'write' as const,
    replace: false,
  };

  it('turns Actual on without this Mac’s server, then connects that budget, with the steps showing', async () => {
    await installer.install({ remote });
    const last = installer.snapshot()!;
    expect(last.error).toBeUndefined();
    expect(last.done).toBe(true);
    expect(statuses(last)).toEqual(['check:done', 'download:done', 'start:done', 'connect:done']);
    expect(args()).toEqual(['addon.sh enable actual --json', 'addon.sh connect actual --instance home --json']);
    expect(stack.calls[1]!.input).toEqual({
      server: 'https://budget.example.com',
      session_token: 'good-token',
      sync_id: 'home-1',
      bind: { default: 'rw', browser: 'rw', 'api-server': 'ro' },
    });
    expect(stack.env().ACTUAL_LOCAL_ENABLED).toBe('0');
    // The first snapshot already lists the steps, before enable answers.
    expect(statuses(snapshots[0]!)).toEqual(['check:pending', 'download:pending', 'start:pending', 'connect:pending']);
  });

  it('ignores the port this Mac’s server would use', async () => {
    fit = { ...FITS, verdict: 'over', port: 'over' };
    await installer.install({ remote });
    expect(installer.snapshot()!.error).toBeUndefined();
  });

  it('stops at the check when the MCP containers don’t fit', async () => {
    fit = { ...FITS, verdict: 'over', memory: 'over' };
    await installer.install({ remote });
    expect(installer.snapshot()!.error).toMatchObject({ step: 'check' });
    expect(stack.calls).toEqual([]);
  });

  it('fails the connect step with the error’s name, leaving Actual on for Undo install', async () => {
    await installer.install({ remote: { ...remote, sessionToken: 'a-cookie' } });
    expect(installer.snapshot()!.error).toMatchObject({
      step: 'connect',
      message: 'Couldn’t connect budget-home: token_expired: the session token has expired',
    });
    expect(stack.env().ACTUAL_MCP_ENABLED).toBe('1');
  });
});

describe('Turn off', () => {
  it('turns the add-on off when no other server’s budget is connected', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1', ACTUAL_LOCAL_ENABLED: '1' });
    await installer.turnOff();
    expect(args()).toEqual(['addon.sh disable actual --json']);
  });

  it('stops only the server while another server’s budget is connected', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1', ACTUAL_LOCAL_ENABLED: '1' });
    stack.addRow('home', { server: 'https://budget.example.com', sync_id: 'home-1' });
    await installer.turnOff();
    expect(args()).toEqual(['addon.sh configure actual', 'addon.sh enable actual --json']);
    expect(stack.calls[0]!.input).toEqual({ local: false });
    expect(stack.env()).toMatchObject({ ACTUAL_MCP_ENABLED: '1', ACTUAL_LOCAL_ENABLED: '0' });
  });

  it('rejects with the script’s error', async () => {
    stack.override = () => ({ kind: 'error', error: 'busy', step: null, message: 'another add-on change is running', logTail: [], lines: [] });
    await expect(installer.turnOff()).rejects.toThrow('busy: another add-on change is running');
  });
});

describe('Remove and delete data', () => {
  it('uses addon.sh remove when no other server’s budget is connected', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1', ACTUAL_LOCAL_ENABLED: '1' });
    stack.addRow('home', { server: 'local', sync_id: 'local-1' });
    await installer.remove({ deleteImages: true });
    const s = installer.snapshot()!;
    expect(statuses(s)).toEqual(['stop:done', 'delete-data:done', 'delete-images:done']);
    expect(s.done).toBe(true);
    expect(args()).toEqual(['addon.sh disable actual --json', 'addon.sh remove actual --delete-data --json']);
    expect(removeImages).toHaveBeenCalledWith(['actualbudget/actual-server:26.11.0', 'boundary-actual-mcp:local']);
  });

  it('keeps other servers’ budgets: disconnects this Mac’s, stops the server, deletes its folder', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1', ACTUAL_LOCAL_ENABLED: '1' });
    stack.addRow('mac', { server: 'local', sync_id: 'local-1' });
    stack.addRow('home', { server: 'https://budget.example.com', sync_id: 'home-1' });
    const serverDir = await actualDataDir(stack.files, stack.root);
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, 'account.sqlite'), 'x');
    const password = path.join(stack.dataRoot, 'addons', 'actual', 'secrets', 'server_password');
    fs.writeFileSync(password, 'pw');
    await installer.remove({ deleteImages: false });
    expect(statuses(installer.snapshot())).toEqual(['disconnect:done', 'stop:done', 'delete-data:done']);
    expect(args()).toEqual([
      'addon.sh disconnect actual --instance mac --json',
      'addon.sh configure actual',
      'addon.sh enable actual --json',
    ]);
    expect(stack.rows()).toEqual(['home']);
    expect(fs.existsSync(serverDir)).toBe(false);
    expect(fs.existsSync(password)).toBe(false);
  });

  it('refuses in a local stack checkout', async () => {
    localStack = true;
    await expect(installer.remove({ deleteImages: false })).rejects.toThrow('local stack');
    expect(stack.calls).toEqual([]);
  });

  it('records a failed step', async () => {
    stack.override = (_s, a) =>
      a[0] === 'remove' ? { kind: 'error', error: 'command_failed', step: 'delete', message: 'deleting data failed', logTail: ['EACCES'], lines: [] } : null;
    await installer.remove({ deleteImages: false });
    expect(installer.snapshot()!.error).toEqual({ step: 'delete-data', message: 'command_failed: deleting data failed', logTail: ['EACCES'] });
  });
});

describe('actualDataDir', () => {
  it('reads ACTUAL_DATA_DIR from .env, relative to the stack root', async () => {
    expect(await actualDataDir(stack.files, stack.root)).toBe(path.join(stack.root, 'data', 'actual', 'server'));
    stack.setEnv({ ACTUAL_DATA_DIR: './elsewhere' });
    expect(await actualDataDir(stack.files, stack.root)).toBe(path.join(stack.root, 'elsewhere'));
  });
});
