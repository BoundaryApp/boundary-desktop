import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import { ADDON_LOCAL_REMOVE_MESSAGE, type AddonInstallSnapshot } from '../../../../shared/types/addons';
import type { AddonScriptLine, AddonScriptOutcome } from '../addonScript';
import { createVikunjaService } from '../vikunjaAddon';
import { createVikunjaInstaller, type VikunjaInstaller } from '../vikunjaInstaller';

// A fake of `addon.sh` for vikunja, from the stack's main (c1bb98a, ships in 0.3.15):
// scripts/addon.sh cmd_enable runs `run_hook prepare` (step prepare), `apply_flags` (step flags,
// VIKUNJA_MCP_ENABLED=1), `start_services` (step start), `run_hook init` (step init) and
// `reload_step` (step reload). disable writes the flag to 0. remove --delete-data refuses
// (bad_input) while enabled, and otherwise emits `delete` steps for the containers, postgres-db,
// the vikunja schema (`db.sh service-remove`) and VIKUNJA_FILES_DIR.

const fits: AddonFit = { verdict: 'ok', memory: 'ok', disk: 'ok', port: 'ok', freeMiB: 4096, suggestedEngineMiB: null };

const done = (lines: AddonScriptLine[] = []): AddonScriptOutcome => ({ kind: 'done', done: { phase: 'done' }, lines });
const step = (name: string, target = ''): AddonScriptLine => ({ phase: 'setup', step: name, target, status: 'running' });

let root: string;
let calls: string[][];
let local: boolean;
let enableFails: AddonScriptOutcome | null;
let afterEnable: number;
let afterDisable: number;
let snapshots: AddonInstallSnapshot[];
let installer: VikunjaInstaller;

const setFlag = (on: boolean) => fs.writeFileSync(path.join(root, '.env'), `VIKUNJA_MCP_ENABLED=${on ? 1 : 0}\n`);
const enabled = () => fs.readFileSync(path.join(root, '.env'), 'utf8').includes('VIKUNJA_MCP_ENABLED=1');

async function run(
  _script: 'addon.sh',
  args: string[],
  options: { onLine?: (l: AddonScriptLine) => void } = {}
): Promise<AddonScriptOutcome> {
  calls.push(args);
  const emit = (lines: AddonScriptLine[]) => lines.forEach((l) => options.onLine?.(l));
  if (args[0] === 'enable') {
    if (enableFails) return enableFails;
    const lines = [step('prepare'), step('flags'), step('start'), step('init'), step('reload')];
    emit(lines);
    setFlag(true);
    return done(lines);
  }
  if (args[0] === 'disable') {
    setFlag(false);
    return done();
  }
  if (args[0] === 'remove') {
    if (enabled()) return { kind: 'error', error: 'bad_input', message: 'disable vikunja first', step: null, logTail: [], lines: [] };
    const lines = [step('delete'), step('delete', 'postgres-db'), step('delete', 'vikunja'), step('delete', './data/vikunja/files')];
    emit(lines);
    return done(lines);
  }
  throw new Error(`unexpected addon.sh ${args.join(' ')}`);
}

const statuses = (s: AddonInstallSnapshot | null) => s?.steps.map((x) => `${x.id}:${x.status}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-fake-'));
  setFlag(false);
  calls = [];
  local = false;
  enableFails = null;
  afterEnable = 0;
  afterDisable = 0;
  snapshots = [];
  const paths = () => ({ root, dataRoot: path.join(root, 'data') });
  const service = createVikunjaService({ paths, run, plain: async () => ({ code: 0, stdout: '[]', stderrTail: [] }), log: () => undefined });
  installer = createVikunjaInstaller({
    service,
    run,
    paths,
    checkFit: async () => fits,
    isLocalStack: () => local,
    exclusive: (work) => work(),
    log: () => undefined,
    afterEnable: async () => {
      afterEnable += 1;
    },
    afterDisable: async () => {
      afterDisable += 1;
    },
  });
  installer.onChange((s) => snapshots.push(s));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Get', () => {
  it('turns Todo lists on with addon.sh enable and gives agents the token after', async () => {
    await installer.install();
    expect(calls).toEqual([['enable', 'vikunja', '--json']]);
    expect(enabled()).toBe(true);
    expect(statuses(installer.snapshot())).toEqual(['check:done', 'start:done', 'setup:done']);
    expect(afterEnable).toBe(1);
  });

  it('shows prepare as Start and init as Setup while they run', async () => {
    await installer.install();
    const runningAt = (id: string) => snapshots.findIndex((s) => s.steps.find((x) => x.id === id)?.status === 'running');
    expect(runningAt('start')).toBeGreaterThanOrEqual(0);
    expect(runningAt('setup')).toBeGreaterThan(runningAt('start'));
  });

  it('fails at Start without touching agents when enable fails', async () => {
    enableFails = { kind: 'error', error: 'compose_failed', message: 'vikunja did not start', step: 'start', logTail: [], lines: [] };
    await installer.install();
    expect(installer.snapshot()?.error?.step).toBe('start');
    expect(afterEnable).toBe(0);
  });

  it('a hook failure names the step it ran in', async () => {
    enableFails = { kind: 'error', error: 'hook_failed', message: 'init failed', step: 'init', logTail: [], lines: [] };
    await installer.install();
    expect(installer.snapshot()?.error?.step).toBe('setup');
  });
});

describe('Turn on', () => {
  it('runs enable and then syncs the agents', async () => {
    await installer.start();
    expect(calls[0]).toEqual(['enable', 'vikunja', '--json']);
    expect(afterEnable).toBe(1);
  });
});

describe('Turn off', () => {
  it('runs disable, then takes the token back from agents', async () => {
    setFlag(true);
    await installer.turnOff();
    expect(calls).toEqual([['disable', 'vikunja', '--json']]);
    expect(afterDisable).toBe(1);
  });
});

describe('Remove', () => {
  it('turns it off, then deletes the data', async () => {
    setFlag(true);
    await installer.remove();
    expect(calls).toEqual([
      ['disable', 'vikunja', '--json'],
      ['remove', 'vikunja', '--delete-data', '--json'],
    ]);
    expect(statuses(installer.snapshot())).toEqual(['stop:done', 'delete-data:done']);
    expect(afterDisable).toBe(1);
  });

  it('skips disable while it is already off', async () => {
    await installer.remove();
    expect(calls).toEqual([['remove', 'vikunja', '--delete-data', '--json']]);
  });

  it('is refused in a local stack', async () => {
    local = true;
    await expect(installer.remove()).rejects.toThrow(ADDON_LOCAL_REMOVE_MESSAGE);
    expect(calls).toEqual([]);
  });
});
