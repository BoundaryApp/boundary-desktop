import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import { ADDON_LOCAL_REMOVE_MESSAGE } from '../../../../shared/types/addons';
import type { AddonScriptLine, AddonScriptOutcome } from '../addonScript';
import {
  builtinAddonAvailable,
  createBuiltinAddonInstaller,
  createBuiltinAddonService,
  moveBuiltinSwitchesToEnv,
  n8nDataLeft,
  readBuiltinEnabled,
  type BuiltinAddonId,
  type BuiltinAddonInstaller,
} from '../builtinAddons';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { localStackFiles } from '../../stackHost/localStackHost';

// A fake of `addon.sh` for n8n and LightRAG, from the stack at v0.3.14: scripts/addon.sh cmd_enable
// runs `apply_flags` (step flags, builtin.flag=1), each one-shot (step start, target n8n-import),
// `start_services` (step start) and `reload_step` (step reload); neither manifest has an init hook.
// disable writes the flag to 0, stops the services and reloads. remove --delete-data refuses
// (bad_input) while the add-on is enabled.

const fits: AddonFit = { verdict: 'ok', memory: 'ok', disk: 'ok', port: 'ok', freeMiB: 4096, suggestedEngineMiB: null };
const done = (lines: AddonScriptLine[] = []): AddonScriptOutcome => ({ kind: 'done', done: { phase: 'done' }, lines });
const step = (name: string, target = ''): AddonScriptLine => ({ phase: 'setup', step: name, target, status: 'running' });
const FLAG: Record<BuiltinAddonId, string> = { n8n: 'AUTOMATION_ENABLED', lightrag: 'LIGHTRAG_MCP_ENABLED' };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-addons-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const writeEnv = (contents: string) => fs.writeFileSync(path.join(root, '.env'), contents);
const readEnv = () => fs.readFileSync(path.join(root, '.env'), 'utf8');

describe('builtinAddonAvailable', () => {
  const read = (files: Record<string, string>) =>
    createFakeStackFiles(Object.fromEntries(Object.entries(files).map(([p, v]) => [`stack:${p}`, v])));

  it('needs addon.sh and a manifest whose builtin block names the flag Boundary reads', async () => {
    const manifest = JSON.stringify({ builtin: { flag: 'AUTOMATION_ENABLED', profile: 'automation', seed: true } });
    expect(await builtinAddonAvailable(read({ 'scripts/addon.sh': '', 'addons/n8n/addon.json': manifest }), 'n8n')).toBe(true);
    expect(await builtinAddonAvailable(read({ 'addons/n8n/addon.json': manifest }), 'n8n')).toBe(false);
    expect(await builtinAddonAvailable(read({ 'scripts/addon.sh': '' }), 'n8n')).toBe(false);
    expect(await builtinAddonAvailable(read({ 'scripts/addon.sh': '', 'addons/lightrag/addon.json': manifest }), 'lightrag')).toBe(false);
    expect(await builtinAddonAvailable(read({ 'scripts/addon.sh': '', 'addons/n8n/addon.json': '{' }), 'n8n')).toBe(false);
  });
});

describe('readBuiltinEnabled', () => {
  it('reads each flag from the stack’s .env, off when missing', async () => {
    const files = localStackFiles({ stackRoot: root, userContentRoot: () => path.join(root, 'data') });
    writeEnv('AUTOMATION_ENABLED=1\nLIGHTRAG_MCP_ENABLED=0\n');
    expect(await readBuiltinEnabled(files, 'n8n')).toBe(true);
    expect(await readBuiltinEnabled(files, 'lightrag')).toBe(false);
    writeEnv('');
    expect(await readBuiltinEnabled(files, 'n8n')).toBe(false);
  });
});

describe('moveBuiltinSwitchesToEnv', () => {
  let moved: string[];
  let stored: Record<BuiltinAddonId, boolean>;
  const files = () => localStackFiles({ stackRoot: root, userContentRoot: () => path.join(root, 'data') });
  const deps = () => ({
    stored: () => stored,
    moved: (r: string) => moved.includes(r),
    markMoved: (r: string): void => void moved.push(r),
  });

  beforeEach(() => {
    moved = [];
    stored = { n8n: false, lightrag: false };
  });

  it('overwrites what setup.sh and sync-profiles.sh seeded with this Mac’s switches, once', async () => {
    writeEnv('COMPOSE_PROFILES=core,automation\nAUTOMATION_ENABLED=1\nLIGHTRAG_MCP_ENABLED=1\nOTHER=x\n');
    stored = { n8n: false, lightrag: true };
    expect(await moveBuiltinSwitchesToEnv(files(), root, deps())).toEqual({ AUTOMATION_ENABLED: '0', LIGHTRAG_MCP_ENABLED: '1' });
    expect(readEnv()).toBe('COMPOSE_PROFILES=core,automation\nAUTOMATION_ENABLED=0\nLIGHTRAG_MCP_ENABLED=1\nOTHER=x\n');
    expect(moved).toEqual([root]);

    // addon.sh owns the flags from now on: a later start leaves them as they are.
    writeEnv('AUTOMATION_ENABLED=1\nLIGHTRAG_MCP_ENABLED=0\n');
    stored = { n8n: false, lightrag: true };
    expect(await moveBuiltinSwitchesToEnv(files(), root, deps())).toEqual({});
    expect(readEnv()).toBe('AUTOMATION_ENABLED=1\nLIGHTRAG_MCP_ENABLED=0\n');
  });

  it('writes a flag missing after the move as off, so sync-profiles.sh doesn’t seed n8n on', async () => {
    moved = [root];
    writeEnv('LIGHTRAG_MCP_ENABLED=1\n');
    expect(await moveBuiltinSwitchesToEnv(files(), root, deps())).toEqual({ AUTOMATION_ENABLED: '0' });
    expect(readEnv()).toBe('LIGHTRAG_MCP_ENABLED=1\nAUTOMATION_ENABLED=0\n');
  });

  it('does nothing, and records nothing, without a .env', async () => {
    expect(await moveBuiltinSwitchesToEnv(files(), root, deps())).toEqual({});
    expect(moved).toEqual([]);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });
});

describe('n8nDataLeft', () => {
  it('is whether the project’s n8n_storage volume exists', async () => {
    const asked: string[] = [];
    expect(await n8nDataLeft(async (v) => void asked.push(v), 'boundary-assistant')).toBe(true);
    expect(asked).toEqual(['boundary-assistant_n8n_storage']);
    expect(
      await n8nDataLeft(async () => {
        throw new Error('no such volume');
      }, 'boundary-assistant')
    ).toBe(false);
  });
});

describe.each<BuiltinAddonId>(['n8n', 'lightrag'])('%s installer', (id) => {
  let calls: string[][];
  let local: boolean;
  let enableFails: AddonScriptOutcome | null;
  let afterDisable: number;
  let installer: BuiltinAddonInstaller;

  const setFlag = (on: boolean) => writeEnv(`${FLAG[id]}=${on ? 1 : 0}\n`);
  const enabled = () => readEnv().includes(`${FLAG[id]}=1`);

  async function run(
    _script: 'addon.sh',
    args: string[],
    options: { onLine?: (l: AddonScriptLine) => void } = {}
  ): Promise<AddonScriptOutcome> {
    calls.push(args);
    const emit = (lines: AddonScriptLine[]) => lines.forEach((l) => options.onLine?.(l));
    if (args[0] === 'enable') {
      if (enableFails) return enableFails;
      const lines = [step('flags'), ...(id === 'n8n' ? [step('start', 'n8n-import')] : []), step('start'), step('reload')];
      emit(lines);
      setFlag(true);
      return done(lines);
    }
    if (args[0] === 'disable') {
      setFlag(false);
      return done([step('flags'), step('stop'), step('reload')]);
    }
    if (args[0] === 'remove') {
      if (enabled()) return { kind: 'error', error: 'bad_input', message: `disable ${id} first`, step: null, logTail: [], lines: [] };
      const lines = [step('delete'), step('delete', 'n8n_storage')];
      emit(lines);
      return done(lines);
    }
    throw new Error(`unexpected addon.sh ${args.join(' ')}`);
  }

  beforeEach(() => {
    setFlag(false);
    calls = [];
    local = false;
    enableFails = null;
    afterDisable = 0;
    const paths = () => ({ root, dataRoot: path.join(root, 'data') });
    const log = (): void => undefined;
    installer = createBuiltinAddonInstaller(id, id, {
      service: createBuiltinAddonService(id, { paths, run, log }),
      run,
      paths,
      checkFit: async () => fits,
      isLocalStack: () => local,
      exclusive: (work) => work(),
      log,
      afterDisable: async () => {
        afterDisable += 1;
      },
    });
  });

  const statuses = () => installer.snapshot()?.steps.map((x) => `${x.id}:${x.status}`);

  it('Get turns it on with addon.sh enable', async () => {
    await installer.install();
    expect(calls).toEqual([['enable', id, '--json']]);
    expect(enabled()).toBe(true);
    expect(statuses()).toEqual(['check:done', 'start:done', 'setup:done']);
  });

  it('Get fails at Start when enable fails, and Undo turns it off again', async () => {
    enableFails = { kind: 'error', error: 'compose_failed', message: 'did not start', step: 'start', logTail: [], lines: [] };
    await installer.install();
    expect(installer.snapshot()?.error?.step).toBe('start');
    await installer.undo();
    expect(calls.at(-1)).toEqual(['disable', id, '--json']);
    expect(afterDisable).toBe(1);
  });

  it('Turn on runs enable, and Turn off runs disable and then the after-disable work', async () => {
    await installer.start();
    expect(calls).toEqual([['enable', id, '--json']]);
    await installer.turnOff();
    expect(calls.at(-1)).toEqual(['disable', id, '--json']);
    expect(enabled()).toBe(false);
    expect(afterDisable).toBe(1);
  });

  it('Remove turns it off, then deletes its data', async () => {
    setFlag(true);
    await installer.remove();
    expect(calls).toEqual([
      ['disable', id, '--json'],
      ['remove', id, '--delete-data', '--json'],
    ]);
    expect(statuses()).toEqual(['stop:done', 'delete-data:done']);
    expect(afterDisable).toBe(1);
  });

  it('Remove skips disable while it’s already off, and is refused in a local stack', async () => {
    await installer.remove();
    expect(calls).toEqual([['remove', id, '--delete-data', '--json']]);
    expect(afterDisable).toBe(1);
    local = true;
    await expect(installer.remove()).rejects.toThrow(ADDON_LOCAL_REMOVE_MESSAGE);
  });
});
