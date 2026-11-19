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
  addonComposeEnv,
  addonComposeProfiles,
  boundaryComposeProfileArgs,
  installedAddonsAt,
  installedAddonsHere,
  setAddonInstalledHere,
  twentyFlags,
} from '../addonComposeState';
import { BOUNDARY_ASSISTANT_COMPOSE_PROFILES } from '../../../../shared/assistantStackConstants';
import { twentyWorkspacesDir } from '../twentyWorkspaces';
import { HOSTED_SETTINGS, LOCAL_SETTINGS, writeTwentyWorkspace } from './twentyStoreFixtures';

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

  it('takes Actual’s profiles and installed state from the stack’s .env, which addon.sh writes', () => {
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
      expect(addonComposeProfiles()).toEqual(['budget']);
      expect(installedAddonsHere()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'ACTUAL_MCP_ENABLED=1\nACTUAL_LOCAL_ENABLED=1\n');
      expect(addonComposeProfiles()).toEqual(['budget', 'budget-local']);
      expect(installedAddonsHere()).toEqual(['actual']);
      // Without the manifest (stack 0.3.12 and earlier) the flags aren't Boundary's to follow.
      fs.rmSync(path.join(root, 'addons'), { recursive: true });
      expect(addonComposeProfiles()).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('addonComposeProfiles adds email and email-drafts from the stack’s .env', () => {
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
      expect(addonComposeProfiles()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=1\nEMAIL_DRAFTS_ENABLED=0\n');
      expect(addonComposeProfiles()).toEqual(['email']);
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=1\nEMAIL_DRAFTS_ENABLED=1\n');
      expect(addonComposeProfiles()).toEqual(['email', 'email-drafts']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('installedAddonsAt lists email while EMAIL_ENABLED is 1', () => {
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
      expect(installedAddonsAt(root)).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'EMAIL_ENABLED=1\n');
      expect(installedAddonsAt(root)).toEqual(['email']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds the bitwarden profile while BITWARDEN_ENABLED is 1 and the stack ships the add-on', () => {
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
      expect(addonComposeProfiles()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_ENABLED=1\n');
      expect(addonComposeProfiles()).toEqual(['bitwarden']);
      expect(installedAddonsAt(root)).toEqual(['bitwarden']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists Todo lists and adds the todo profile while VIKUNJA_MCP_ENABLED is 1', () => {
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
      expect(installedAddonsAt(root)).toEqual([]);
      expect(addonComposeProfiles()).toEqual([]);
      fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=1\n');
      expect(installedAddonsAt(root)).toEqual(['vikunja']);
      expect(addonComposeProfiles()).toEqual(['todo']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads no add-ons while no stack root resolves', () => {
    installed.ids = ['twenty'];
    installed.root = null;
    expect(addonComposeProfiles()).toEqual([]);
    expect(installed.roots).toEqual([]);
  });

  it("reads the active stack root's list", () => {
    installed.ids = ['twenty'];
    addonComposeProfiles();
    addonComposeEnv();
    expect(installed.roots).toEqual(['/stacks/active', '/stacks/active']);
  });

  it('adds crm and the Twenty flags when Twenty is installed', () => {
    installed.ids = ['twenty'];
    expect(addonComposeProfiles()).toEqual(['crm']);
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
    expect(boundaryComposeProfileArgs()).toEqual(
      [...BOUNDARY_ASSISTANT_COMPOSE_PROFILES, 'crm'].flatMap((p) => ['--profile', p]),
    );
  });

  it("sets both Twenty flags to 0 when it isn't", () => {
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' });
    expect(boundaryComposeProfileArgs()).toEqual(
      BOUNDARY_ASSISTANT_COMPOSE_PROFILES.flatMap((p) => ['--profile', p]),
    );
  });

  it('treats Twenty as not installed when nothing is stored, even mid-install', () => {
    installed.ids = [];
    expect(addonComposeProfiles()).toEqual([]);
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' });
  });

  it('follows n8n’s and LightRAG’s flags in the stack’s .env, adding rag but not automation again', () => {
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
      expect(installedAddonsHere()).toEqual([]);
      expect(boundaryComposeProfileArgs()).toEqual(BOUNDARY_ASSISTANT_COMPOSE_PROFILES.flatMap((p) => ['--profile', p]));
      fs.writeFileSync(path.join(root, '.env'), 'AUTOMATION_ENABLED=1\nLIGHTRAG_MCP_ENABLED=1\n');
      expect(installedAddonsHere()).toEqual(['n8n', 'lightrag']);
      expect(BOUNDARY_ASSISTANT_COMPOSE_PROFILES).toContain('automation');
      expect(addonComposeProfiles()).toEqual(['rag']);
      // Without the manifests (stack 0.3.12 and earlier) the flags aren't Boundary's to follow.
      fs.rmSync(path.join(root, 'addons'), { recursive: true });
      expect(installedAddonsHere()).toEqual([]);
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

  it('turns both on while Twenty is installed', () => {
    expect(twentyFlags(true, dir)).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
  });

  it('keeps MCP on for a stored hosted workspace while Twenty is not installed', () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    expect(twentyFlags(false, dir)).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' });
  });

  it('turns both off when the only stored workspace is local and Twenty is not installed', () => {
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    expect(twentyFlags(false, dir)).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' });
  });

  it('gives compose the same values for the active stack root', () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' });
    installed.ids = ['twenty'];
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
  });
});
