import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingChanges } from '../pendingRestart';
import { OFF, ON, fakeDeps, pending } from './addonInstallerFakes';

vi.mock('../../assistant/AssistantStackService', async () => (await import('./addonInstallerFakes')).assistantStackServiceMock());
vi.mock('../../assistant/AssistantStackStore', async () => (await import('./addonInstallerFakes')).storeMock());
vi.mock('../../assistant/resolveAssistantRoot', async () => (await import('./addonInstallerFakes')).resolveAssistantRootMock());
vi.mock('../../assistant/localStackMode', async () => (await import('./addonInstallerFakes')).localStackModeMock());
vi.mock('../addonHostFacts', async () => (await import('./addonInstallerFakes')).addonHostFactsMock());

import { createAddonInstaller, type AddonInstallerDeps } from '../addonInstaller';
import { twentyWorkspacesDir } from '../twentyWorkspaces';
import { HOSTED_SETTINGS, LOCAL_SETTINGS, writeTwentyWorkspace } from './twentyStoreFixtures';

describe('Twenty workspaces', () => {
  let tmp: string;
  let dir: string;
  const TURN_OFF = 'Turn off this Mac’s Twenty: agents drop crm-main';

  beforeEach(() => {
    vi.useFakeTimers();
    pending.list = [];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-workspaces-'));
    dir = twentyWorkspacesDir(tmp);
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const stored = () => fs.readdirSync(path.join(dir, 'instances')).sort();
  const writeLocal = () => writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS, { keyRw: 'k' });
  const writeHosted = (slug: string) => writeTwentyWorkspace(dir, slug, HOSTED_SETTINGS, { keyRw: 'k' });

  const depsInStack = (overrides: Partial<AddonInstallerDeps> = {}) =>
    fakeDeps({ stackPaths: () => ({ root: tmp, dataRoot: path.join(tmp, 'data') }), ...overrides });

  it('turnOff with a hosted workspace keeps TWENTY_MCP_ENABLED=1, stops and removes the containers, does not reload, and adds the pending text', async () => {
    writeLocal();
    writeHosted('work');
    writeHosted('sales');
    const { deps, calls } = depsInStack();

    await createAddonInstaller(deps).turnOff('twenty');

    expect(stored()).toEqual(['main.json', 'sales.json', 'work.json']);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' });
    expect(calls.map((c) => c.args[2])).toEqual(['stop', 'rm']);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
    expect(pendingChanges()).toEqual([`${TURN_OFF} and keep crm-sales, crm-work`]);
  });

  it('turnOff with no hosted workspace turns MCP off and adds the pending text', async () => {
    writeLocal();
    const { deps } = depsInStack();

    await createAddonInstaller(deps).turnOff('twenty');

    expect(stored()).toEqual(['main.json']);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', OFF);
    expect(deps.reloadHermes).not.toHaveBeenCalled();
    expect(pendingChanges()).toEqual([TURN_OFF]);
  });

  it('undo writes 0/0 with no hosted workspace', async () => {
    writeLocal();
    const { deps } = depsInStack({ isInstalled: vi.fn(() => true) });
    await createAddonInstaller(deps).undo('twenty');
    expect(stored()).toEqual(['main.json']);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', OFF);
  });

  it('start turns both flags on, reloads at once and clears the pending list', async () => {
    writeLocal();
    pending.list = [`${TURN_OFF}`, 'Connect crm-work (look things up)'];
    const { deps, calls } = depsInStack({ isInstalled: vi.fn(() => true) });

    await createAddonInstaller(deps).start('twenty');

    expect(calls.some((c) => c.args.includes('up'))).toBe(true);
    expect(deps.syncStackFlags).toHaveBeenCalledWith('twenty', ON);
    expect(deps.reloadHermes).toHaveBeenCalledTimes(1);
    expect(pending.list).toEqual([]);
  });

  it('start keeps the pending list when the reload fails', async () => {
    pending.list = [TURN_OFF];
    const { deps } = depsInStack({
      isInstalled: vi.fn(() => true),
      reloadHermes: vi.fn(async () => ({ success: false, error: 'Hermes API did not become healthy' })),
    });
    await expect(createAddonInstaller(deps).start('twenty')).rejects.toThrow('Hermes API did not become healthy');
    expect(pendingChanges()).toEqual([TURN_OFF]);
  });

  it('install leaves the pending list for its restart, which clears it', async () => {
    writeLocal();
    pending.list = ['Disconnect crm-work'];
    const { deps } = depsInStack();
    const installer = createAddonInstaller(deps);

    await installer.install('twenty');
    expect(installer.snapshot()?.error).toBeUndefined();
    expect(pendingChanges()).toEqual(['Disconnect crm-work']);
    await installer.restart('twenty');

    expect(pending.list).toEqual([]);
  });

  it('undo clears the pending list after its reload', async () => {
    pending.list = ['Disconnect crm-work'];
    const { deps } = depsInStack({ isInstalled: vi.fn(() => true) });
    await createAddonInstaller(deps).undo('twenty');
    expect(pending.list).toEqual([]);
  });
});
