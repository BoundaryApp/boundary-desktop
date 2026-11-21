import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonId } from '../../../../shared/types/addons';
import type { TwentyConnectInput } from '../crmScript';

const pending = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock('../../assistant/AssistantStackService', () => ({
  getAssistantStackAccess: vi.fn(),
  reloadHermesForAddons: vi.fn(),
}));
vi.mock('../../assistant/AssistantStackStore', () => ({
  getInstalledAddons: (): AddonId[] => [],
  setAddonInstalled: vi.fn(),
  getPendingAddonChanges: () => pending.list,
  setPendingAddonChanges: (_root: string, list: string[]) => {
    pending.list = list;
  },
}));
vi.mock('../../assistant/resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => ({ root: '/stacks/test' }),
}));

import { runExclusive } from '../addonInstaller';
import { pendingChanges } from '../pendingRestart';
import { createTwentyService, type TwentyServiceDeps } from '../twentyService';
import {
  HOSTED_SETTINGS,
  LOCAL_SETTINGS,
  readTwentyWorkspace,
  twentyWorkspacesDir,
  writeTwentyWorkspace,
} from './twentyStoreFixtures';

type RunOptions = Parameters<TwentyServiceDeps['run']>[0];

const input = (over: Partial<TwentyConnectInput> = {}): TwentyConnectInput => ({
  slug: 'work',
  url: 'https://crm.example.com',
  keyRw: 'rw-key',
  keyRo: 'ro-key',
  access: 'read',
  replace: false,
  ...over,
});

const runScript: TwentyServiceDeps['runScript'] = async () => 0;

describe('twenty service', () => {
  let root: string;
  let dir: string;
  let calls: RunOptions[];
  let result: { code: number; lines: string[] };

  const make = (over: Partial<TwentyServiceDeps> = {}) =>
    createTwentyService({
      root: () => root,
      baseEnv: async () => ({ PATH: '/usr/bin', TWENTY_WORKSPACE_URL: 'http://localhost:3000' }),
      runScript,
      run: async (options) => {
        calls.push(options);
        return result;
      },
      ...over,
    });

  beforeEach(() => {
    pending.list = [];
    calls = [];
    result = { code: 0, lines: ["[crm] Saved workspace 'work'"] };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'twenty-service-'));
    dir = twentyWorkspacesDir(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists the stored workspaces without their keys, and nothing without a stack root', async () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS, { keyRw: 'secret' });
    const [work] = await make().listWorkspaces();
    expect(work).toMatchObject({ slug: 'work', local: false, hasWriteKey: true });
    expect(JSON.stringify(work)).not.toContain('secret');
    expect(await make({ root: () => null }).listWorkspaces()).toEqual([]);
  });

  it('connect runs crm.sh add without TWENTY_WORKSPACE_URL and adds the pending text on success', async () => {
    const service = make();
    expect(await service.connect(input())).toEqual({ ok: true, checks: [] });
    expect(calls[0].args).toEqual(['add', '--slug', 'work', '--url', 'https://crm.example.com']);
    expect(calls[0].runScript).toBe(runScript);
    expect(calls[0].env.PATH).toBe('/usr/bin');
    expect('TWENTY_WORKSPACE_URL' in calls[0].env).toBe(false);
    expect(pendingChanges()).toEqual(['Connect crm-work (look things up)']);

    await service.connect(input({ slug: 'sales', access: 'write' }));
    expect(pendingChanges()).toEqual(['Connect crm-work (look things up)', 'Connect crm-sales (make changes)']);
  });

  it('connect and disconnect leave the local workspace stored while Twenty is not installed', async () => {
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    const service = make();
    await service.connect(input({ slug: 'sales' }));
    await service.disconnect('work');
    expect(fs.readdirSync(path.join(dir, 'instances')).sort()).toEqual(['main.json', 'work.json']);
    expect(calls).toHaveLength(2);
  });

  it('connect returns a failure and adds nothing', async () => {
    result = { code: 1, lines: ['[crm] ERROR: no answer from https://crm.example.com/mcp — check the URL; nothing written'] };
    expect(await make().connect(input())).toMatchObject({ ok: false, reason: 'no-answer' });
    expect(pendingChanges()).toEqual([]);
  });

  it('disconnect runs crm.sh remove and adds the pending text', async () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    await make().disconnect('work');
    expect(calls[0].args).toEqual(['remove', '--slug', 'work']);
    expect('TWENTY_WORKSPACE_URL' in calls[0].env).toBe(false);
    expect(pendingChanges()).toEqual(['Disconnect crm-work']);
  });

  it('disconnect sets TWENTY_MCP_ENABLED in .env for the workspaces left, which crm.sh remove leaves', async () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    fs.writeFileSync(path.join(root, '.env'), 'TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=1\n');
    // As crm.sh remove does: the instance file goes, the flag stays.
    const removing = make({
      run: async (options) => {
        calls.push(options);
        fs.rmSync(path.join(dir, 'instances', 'work.json'));
        return result;
      },
    });
    await removing.disconnect('work');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
  });

  it('disconnect refuses the local workspace', async () => {
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    await expect(make().disconnect('main')).rejects.toThrow(
      'crm-main is this Mac’s Twenty. Turn it off on its card instead.'
    );
    expect(calls).toEqual([]);
    expect(pendingChanges()).toEqual([]);
  });

  it('disconnect rejects with the script error and adds nothing', async () => {
    result = { code: 1, lines: ["[crm] ERROR: no workspace 'work'"] };
    await expect(make().disconnect('work')).rejects.toThrow("no workspace 'work'");
    expect(pendingChanges()).toEqual([]);
  });

  it('setAccess refuses while the workspace lacks the needed key', async () => {
    const settings = { ...HOSTED_SETTINGS, access: 'write' };
    writeTwentyWorkspace(dir, 'work', settings, { keyRw: 'k' });
    await expect(make().setAccess('work', 'read')).rejects.toThrow(
      'crm-work has no read-only key. Connect it again with one.'
    );
    expect(readTwentyWorkspace(dir, 'work')).toEqual(settings);
    expect(pendingChanges()).toEqual([]);
  });

  it('setAccess rewrites the stored access and keeps one pending line per workspace', async () => {
    writeTwentyWorkspace(dir, 'work', { ...HOSTED_SETTINGS, access: 'write' }, { keyRw: 'k', keyRo: 'r' });
    const service = make();
    await service.setAccess('work', 'read');
    expect(readTwentyWorkspace(dir, 'work')).toMatchObject({ access: 'read' });
    expect(pendingChanges()).toEqual(['crm-work: look things up']);
    await service.setAccess('work', 'write');
    expect(pendingChanges()).toEqual(['crm-work: make changes']);
  });

  it('connect while an install runs rejects with the busy message', async () => {
    let release!: () => void;
    const held = runExclusive(() => new Promise<void>((resolve) => (release = resolve)));
    const service = make();
    await expect(service.connect(input())).rejects.toThrow('An add-on install is already running.');
    await expect(service.disconnect('work')).rejects.toThrow('An add-on install is already running.');
    await expect(service.setAccess('work', 'read')).rejects.toThrow('An add-on install is already running.');
    expect(calls).toEqual([]);
    release();
    await held;
  });

  it('refuses mutations without a stack root', async () => {
    await expect(make({ root: () => null }).connect(input())).rejects.toThrow(
      'The agent stack folder could not be found.'
    );
  });
});
