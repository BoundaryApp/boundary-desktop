import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installed = vi.hoisted(() => ({
  ids: [] as string[],
  roots: [] as string[],
  root: '/stacks/active' as string | null,
  set: [] as unknown[][],
}));

vi.mock('../../assistant/AssistantStackStore', () => ({
  getInstalledAddons: (root: string) => {
    installed.roots.push(root);
    return installed.ids;
  },
  setAddonInstalled: (...args: unknown[]): void => void installed.set.push(args),
}));
vi.mock('../../assistant/resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: (): { root: string | null; error?: string } =>
    installed.root ? { root: installed.root } : { root: null, error: 'no stack here' },
}));

import {
  addonComposeProfiles,
  boundaryComposeProfileArgs,
  installedAddonsAt,
  installedAddonsHere,
  moveTwentyFlagsToEnv,
  setAddonInstalledHere,
  twentyFlags,
} from '../addonComposeState';
import { BOUNDARY_ASSISTANT_COMPOSE_PROFILES } from '../../../../shared/assistantStackConstants';
import { stackFilesAt } from '../../stackHost/activeStack';
import { HOSTED_SETTINGS, LOCAL_SETTINGS, writeTwentyWorkspace, twentyWorkspacesDir } from './twentyStoreFixtures';

describe('addonComposeState', () => {
  beforeEach(() => {
    installed.ids = [];
    installed.roots = [];
    installed.root = '/stacks/active';
    installed.set = [];
  });

  it('records an install for the resolved root, and refuses without one', () => {
    setAddonInstalledHere('twenty', true);
    expect(installed.set).toEqual([['/stacks/active', 'twenty', true]]);
    installed.root = null;
    expect(() => setAddonInstalledHere('twenty', false)).toThrow('no stack here');
  });

  it('takes Actual’s profiles and installed state from the stack’s .env, which addon.sh writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-profiles-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'actual'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(
        path.join(root, 'addons', 'actual', 'addon.json'),
        JSON.stringify({ hooks: { init: {} }, instances: { connect: {} } })
      );
      installed.root = root;
      // A stale record in Boundary's store doesn't count for Actual.
      installed.ids = ['actual'];
      fs.writeFileSync(path.join(root, '.env'), 'ACTUAL_MCP_ENABLED=1\nACTUAL_LOCAL_ENABLED=0\n');
      expect(await addonComposeProfiles()).toEqual(['budget']);
      expect(await installedAddonsHere()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'ACTUAL_MCP_ENABLED=1\nACTUAL_LOCAL_ENABLED=1\n');
      expect(await addonComposeProfiles()).toEqual(['budget', 'budget-local']);
      expect(await installedAddonsHere()).toEqual(['actual']);
      // Without the manifest (stack 0.3.12 and earlier) the flags aren't Boundary's to follow.
      fs.rmSync(path.join(root, 'addons'), { recursive: true });
      expect(await addonComposeProfiles()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('addonComposeProfiles adds email and email-drafts from the stack’s .env', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-profiles-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'email'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(
        path.join(root, 'addons', 'email', 'addon.json'),
        JSON.stringify({ instances: { name: 'accounts' }, commands: { mailboxes: {} } })
      );
      installed.root = root;
      installed.ids = ['email'];
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=0\nEMAIL_DRAFTS_ENABLED=1\n');
      expect(await addonComposeProfiles()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=1\nEMAIL_DRAFTS_ENABLED=0\n');
      expect(await addonComposeProfiles()).toEqual(['email']);
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=1\nEMAIL_DRAFTS_ENABLED=1\n');
      expect(await addonComposeProfiles()).toEqual(['email', 'email-drafts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('installedAddonsAt lists email while EMAIL_ENABLED is 1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-installed-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'email'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(
        path.join(root, 'addons', 'email', 'addon.json'),
        JSON.stringify({ instances: { name: 'accounts' }, commands: { mailboxes: {} } })
      );
      // A stale record in Boundary's store doesn't count for email.
      installed.ids = ['email'];
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=0\n');
      expect(await installedAddonsAt(root)).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=1\n');
      expect(await installedAddonsAt(root)).toEqual(['email']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds the bitwarden profile while BITWARDEN_ENABLED is 1 and the stack ships the add-on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitwarden-profiles-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'bitwarden'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(path.join(root, 'scripts', 'vault.sh'), '');
      fs.writeFileSync(
        path.join(root, 'addons', 'bitwarden', 'addon.json'),
        JSON.stringify({ instances: { connect: {}, disconnect: {} } })
      );
      installed.root = root;
      fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_ENABLED=0\n');
      expect(await addonComposeProfiles()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_ENABLED=1\n');
      expect(await addonComposeProfiles()).toEqual(['bitwarden']);
      expect(await installedAddonsAt(root)).toEqual(['bitwarden']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists Todo lists and adds the todo profile while VIKUNJA_MCP_ENABLED is 1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-installed-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'vikunja'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(
        path.join(root, 'addons', 'vikunja', 'addon.json'),
        JSON.stringify({ hooks: { prepare: { script: ['scripts/todo.sh', 'prepare'] } } })
      );
      installed.root = root;
      // A stale record in Boundary's store doesn't count for Todo lists.
      installed.ids = ['vikunja'];
      fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=0\n');
      expect(await installedAddonsAt(root)).toEqual([]);
      expect(await addonComposeProfiles()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=1\n');
      expect(await installedAddonsAt(root)).toEqual(['vikunja']);
      expect(await addonComposeProfiles()).toEqual(['todo']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads no add-ons while no stack root resolves', async () => {
    installed.ids = ['twenty'];
    installed.root = null;
    expect(await addonComposeProfiles()).toEqual([]);
    expect(installed.roots).toEqual([]);
  });

  it("reads the active stack root's list", async () => {
    installed.ids = ['twenty'];
    await addonComposeProfiles();
    await installedAddonsHere();
    expect(installed.roots).toEqual(['/stacks/active', '/stacks/active']);
  });

  it('adds crm when Twenty is installed', async () => {
    installed.ids = ['twenty'];
    expect(await addonComposeProfiles()).toEqual(['crm']);
    expect(await boundaryComposeProfileArgs()).toEqual(
      [...BOUNDARY_ASSISTANT_COMPOSE_PROFILES, 'crm'].flatMap((p) => ['--profile', p]),
    );
  });

  it("adds no crm when it isn't", async () => {
    expect(await boundaryComposeProfileArgs()).toEqual(
      BOUNDARY_ASSISTANT_COMPOSE_PROFILES.flatMap((p) => ['--profile', p]),
    );
  });

  it('treats Twenty as not installed when nothing is stored, even mid-install', async () => {
    installed.ids = [];
    expect(await addonComposeProfiles()).toEqual([]);
  });

  it('follows n8n’s and LightRAG’s flags in the stack’s .env, adding rag but not automation again', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-profiles-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.mkdirSync(path.join(root, 'addons', 'n8n'), { recursive: true });
      fs.mkdirSync(path.join(root, 'addons', 'lightrag'), { recursive: true });
      fs.writeFileSync(path.join(root, 'addons', 'n8n', 'addon.json'), JSON.stringify({ builtin: { flag: 'AUTOMATION_ENABLED' } }));
      fs.writeFileSync(path.join(root, 'addons', 'lightrag', 'addon.json'), JSON.stringify({ builtin: { flag: 'LIGHTRAG_MCP_ENABLED' } }));
      installed.root = root;
      // A record in Boundary's store doesn't count for either.
      installed.ids = ['n8n', 'lightrag'];
      fs.writeFileSync(path.join(root, '.env'), 'AUTOMATION_ENABLED=0\nLIGHTRAG_MCP_ENABLED=0\n');
      expect(await installedAddonsHere()).toEqual([]);
      expect(await boundaryComposeProfileArgs()).toEqual(BOUNDARY_ASSISTANT_COMPOSE_PROFILES.flatMap((p) => ['--profile', p]));
      fs.writeFileSync(path.join(root, '.env'), 'AUTOMATION_ENABLED=1\nLIGHTRAG_MCP_ENABLED=1\n');
      expect(await installedAddonsHere()).toEqual(['n8n', 'lightrag']);
      expect(BOUNDARY_ASSISTANT_COMPOSE_PROFILES).toContain('automation');
      expect(await addonComposeProfiles()).toEqual(['rag']);
      // Without the manifests (stack 0.3.12 and earlier) the flags aren't Boundary's to follow.
      fs.rmSync(path.join(root, 'addons'), { recursive: true });
      expect(await installedAddonsHere()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('twentyFlags', () => {
  let tmp: string;
  let dir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twenty-flags-'));
    dir = twentyWorkspacesDir(tmp);
    installed.ids = [];
    installed.root = tmp;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('turns both on while Twenty is installed', async () => {
    expect(await twentyFlags(true, stackFilesAt(tmp))).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
  });

  it('keeps MCP on for a stored hosted workspace while Twenty is not installed', async () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    expect(await twentyFlags(false, stackFilesAt(tmp))).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' });
  });

  it('turns both off when the only stored workspace is local and Twenty is not installed', async () => {
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    expect(await twentyFlags(false, stackFilesAt(tmp))).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' });
  });
});

describe('moveTwentyFlagsToEnv', () => {
  let tmp: string;
  let dir: string;
  let movedRoots: string[];
  const deps = (twentyInstalled: boolean) => ({
    installed: (root: string) => {
      expect(root).toBe(tmp);
      return twentyInstalled;
    },
    moved: (root: string) => movedRoots.includes(root),
    markMoved: (root: string): void => {
      movedRoots.push(root);
    },
  });
  const readEnv = () => fs.readFileSync(path.join(tmp, '.env'), 'utf8');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'twenty-move-'));
    dir = twentyWorkspacesDir(tmp);
    movedRoots = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes both flags on for an installed Twenty, over stale values, and marks the root', async () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'COMPOSE_PROFILES=core\nTWENTY_LOCAL_ENABLED=0\n');
    const written = await moveTwentyFlagsToEnv(stackFilesAt(tmp), tmp, deps(true));
    expect(written).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
    expect(readEnv()).toBe('COMPOSE_PROFILES=core\nTWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n');
    expect(movedRoots).toEqual([tmp]);
  });

  it('keeps MCP on for a hosted workspace with Twenty not installed, as compose got before', async () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'TWENTY_MCP_ENABLED=0\n');
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    await moveTwentyFlagsToEnv(stackFilesAt(tmp), tmp, deps(false));
    expect(readEnv()).toBe('TWENTY_MCP_ENABLED=1\nTWENTY_LOCAL_ENABLED=0\n');
  });

  it('writes both off with nothing installed or stored', async () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n');
    await moveTwentyFlagsToEnv(stackFilesAt(tmp), tmp, deps(false));
    expect(readEnv()).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
  });

  it('leaves values already moved, and fills only a flag missing from a .env set up again', async () => {
    fs.writeFileSync(path.join(tmp, '.env'), 'TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
    movedRoots = [tmp];
    expect(await moveTwentyFlagsToEnv(stackFilesAt(tmp), tmp, deps(true))).toEqual({});
    expect(readEnv()).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
    fs.writeFileSync(path.join(tmp, '.env'), 'TWENTY_MCP_ENABLED=0\n');
    expect(await moveTwentyFlagsToEnv(stackFilesAt(tmp), tmp, deps(true))).toEqual({ TWENTY_LOCAL_ENABLED: '1' });
    expect(readEnv()).toBe('TWENTY_MCP_ENABLED=0\nTWENTY_LOCAL_ENABLED=1\n');
    expect(movedRoots).toEqual([tmp]);
  });

  it('writes nothing and marks nothing without a .env, so the next start tries again', async () => {
    expect(await moveTwentyFlagsToEnv(stackFilesAt(tmp), tmp, deps(true))).toEqual({});
    expect(fs.existsSync(path.join(tmp, '.env'))).toBe(false);
    expect(movedRoots).toEqual([]);
  });
});
