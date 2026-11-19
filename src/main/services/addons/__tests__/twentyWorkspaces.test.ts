import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasActiveHostedWorkspaces,
  listTwentyWorkspaces,
  localWorkspaceId,
  setTwentyWorkspaceAccess,
  twentyWorkspacesDir,
} from '../twentyWorkspaces';
import {
  HOSTED_SETTINGS,
  LOCAL_SETTINGS,
  readTwentyWorkspace,
  signedInLocalSettings,
  writeTwentyWorkspace,
} from './twentyStoreFixtures';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twenty-workspaces-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('twentyWorkspacesDir', () => {
  it('points at data/addons/twenty under the stack root when .env sets no data root', () => {
    expect(twentyWorkspacesDir(dir)).toBe(path.join(dir, 'data', 'addons', 'twenty'));
  });

  it("honours ASSISTANT_DATA_ROOT in the root's .env", () => {
    const dataRoot = path.join(dir, 'elsewhere');
    fs.writeFileSync(path.join(dir, '.env'), `ASSISTANT_DATA_ROOT=${dataRoot}\n`);
    expect(twentyWorkspacesDir(dir)).toBe(path.join(dataRoot, 'addons', 'twenty'));
  });
});

describe('listTwentyWorkspaces', () => {
  it('returns [] for a missing store', () => {
    expect(listTwentyWorkspaces(path.join(dir, 'nope'))).toEqual([]);
  });

  it('reads a local workspace with both keys, defaulting access to read', () => {
    writeTwentyWorkspace(dir, 'main', signedInLocalSettings(), { keyRo: 'ro', keyRw: 'rw' });
    expect(listTwentyWorkspaces(dir)).toEqual([
      {
        slug: 'main',
        local: true,
        url: 'http://twenty-server:3000',
        workspaceUrl: 'http://localhost:3000/',
        access: 'read',
        skippedReason: null,
        hasReadKey: true,
        hasWriteKey: true,
        parked: false,
      },
    ]);
  });

  it('reads a hosted workspace with write access and only a read-write key', () => {
    writeTwentyWorkspace(dir, 'work', { ...HOSTED_SETTINGS, access: 'write' }, { keyRw: 'rw' });
    expect(listTwentyWorkspaces(dir)[0]).toMatchObject({
      slug: 'work',
      local: false,
      url: 'https://crm.example.com',
      workspaceUrl: '',
      access: 'write',
      hasReadKey: false,
      hasWriteKey: true,
    });
  });

  it('counts an empty key file as absent', () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS, { keyRo: '', keyRw: 'rw' });
    expect(listTwentyWorkspaces(dir)[0]).toMatchObject({ hasReadKey: false, hasWriteKey: true });
  });

  it('treats the twenty-server URL as local without the local flag, with a trailing slash or /mcp', () => {
    writeTwentyWorkspace(dir, 'a', { url: 'http://twenty-server:3000/mcp' });
    writeTwentyWorkspace(dir, 'b', { url: 'http://twenty-server:3000/' });
    writeTwentyWorkspace(dir, 'c', { url: 'https://c.example.com', local: true });
    writeTwentyWorkspace(dir, 'd', { url: 'https://d.example.com' });
    expect(listTwentyWorkspaces(dir).map((w) => [w.slug, w.local])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
    ]);
  });

  it('never returns key values', () => {
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS, { keyRo: 'ro-secret-local', keyRw: 'rw-secret-local' });
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS, { keyRo: 'ro-secret-hosted' });
    const json = JSON.stringify(listTwentyWorkspaces(dir));
    for (const secret of ['ro-secret-local', 'rw-secret-local', 'ro-secret-hosted']) {
      expect(json).not.toContain(secret);
    }
  });

  it('sorts local first, then by slug', () => {
    writeTwentyWorkspace(dir, 'zeta', HOSTED_SETTINGS);
    writeTwentyWorkspace(dir, 'alpha', HOSTED_SETTINGS);
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    expect(listTwentyWorkspaces(dir).map((w) => w.slug)).toEqual(['main', 'alpha', 'zeta']);
  });

  it('ignores other files, bad slugs and settings that are not a JSON object', () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS);
    writeTwentyWorkspace(dir, 'Bad', HOSTED_SETTINGS);
    writeTwentyWorkspace(dir, '9lives', HOSTED_SETTINGS);
    const instances = path.join(dir, 'instances');
    fs.writeFileSync(path.join(instances, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(instances, 'list.json'), '[]');
    fs.writeFileSync(path.join(instances, 'notes.txt'), 'ignored');
    expect(listTwentyWorkspaces(dir).map((w) => w.slug)).toEqual(['work']);
  });

  it('flags an access that is neither read nor write, and still lists it', () => {
    writeTwentyWorkspace(dir, 'a', { ...HOSTED_SETTINGS, access: 'Read' });
    writeTwentyWorkspace(dir, 'b', { ...HOSTED_SETTINGS, access: 'rw' });
    writeTwentyWorkspace(dir, 'c', { ...HOSTED_SETTINGS, access: '' });
    writeTwentyWorkspace(dir, 'd', { ...HOSTED_SETTINGS, access: 'write' });
    const byslug = Object.fromEntries(listTwentyWorkspaces(dir).map((w) => [w.slug, w]));
    const reason = 'access must be read or write';
    expect(byslug.a).toMatchObject({ access: 'read', skippedReason: reason });
    expect(byslug.b).toMatchObject({ access: 'read', skippedReason: reason });
    expect(byslug.c).toMatchObject({ access: 'read', skippedReason: null });
    expect(byslug.d).toMatchObject({ access: 'write', skippedReason: null });
  });
});

describe('localWorkspaceId', () => {
  it('returns the stored id and address, defaulting to main', () => {
    writeTwentyWorkspace(dir, 'main', signedInLocalSettings());
    expect(localWorkspaceId(dir)).toEqual({ id: 'ws-1', workspaceUrl: 'http://localhost:3000/' });
  });

  it('reads another slug when given one', () => {
    writeTwentyWorkspace(dir, 'home', signedInLocalSettings('ws-2', 'http://localhost:3001/'));
    expect(localWorkspaceId(dir, 'home')).toEqual({ id: 'ws-2', workspaceUrl: 'http://localhost:3001/' });
  });

  it('returns null without a workspace or an id', () => {
    expect(localWorkspaceId(dir)).toBeNull();
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    expect(localWorkspaceId(dir)).toBeNull();
  });
});

describe('setTwentyWorkspaceAccess', () => {
  it('rewrites only access, keeps the other settings and the keys, and keeps mode 600', () => {
    const settings = { ...HOSTED_SETTINGS, workspace_url: 'https://crm.example.com/', access: 'read' };
    const file = writeTwentyWorkspace(dir, 'work', settings, { keyRo: 'ro', keyRw: 'rw' });
    fs.chmodSync(file, 0o644);
    setTwentyWorkspaceAccess(dir, 'work', 'write');
    expect(readTwentyWorkspace(dir, 'work')).toEqual({ ...settings, access: 'write' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(dir, 'instances'))).toEqual(['work.json']);
    expect(fs.readFileSync(path.join(dir, 'secrets', 'work.key_ro'), 'utf8')).toBe('ro');
    expect(fs.readFileSync(path.join(dir, 'secrets', 'work.key_rw'), 'utf8')).toBe('rw');
  });

  it('adds access when the settings lack it', () => {
    writeTwentyWorkspace(dir, 'main', signedInLocalSettings(), { keyRo: 'ro' });
    setTwentyWorkspaceAccess(dir, 'main', 'read');
    expect(readTwentyWorkspace(dir, 'main')).toEqual({ ...signedInLocalSettings(), access: 'read' });
  });

  it('refuses read without a read-only key', () => {
    writeTwentyWorkspace(dir, 'work', HOSTED_SETTINGS, { keyRo: '', keyRw: 'rw' });
    expect(() => setTwentyWorkspaceAccess(dir, 'work', 'read')).toThrow(
      'crm-work has no read-only key. Connect it again with one.',
    );
  });

  it('refuses write without a read-write key and leaves the settings alone', () => {
    const settings = { ...HOSTED_SETTINGS, access: 'read' };
    writeTwentyWorkspace(dir, 'work', settings, { keyRo: 'ro' });
    expect(() => setTwentyWorkspaceAccess(dir, 'work', 'write')).toThrow(
      'crm-work has no read-write key. Connect it again with one.',
    );
    expect(readTwentyWorkspace(dir, 'work')).toEqual(settings);
  });

  it('refuses a workspace that is not stored, or a bad slug', () => {
    expect(() => setTwentyWorkspaceAccess(dir, 'work', 'read')).toThrow(
      'crm-work has no workspace in the add-on store.',
    );
    expect(() => setTwentyWorkspaceAccess(dir, '../x', 'read')).toThrow(
      'crm-../x has no workspace in the add-on store.',
    );
    expect(fs.existsSync(path.join(dir, 'instances'))).toBe(false);
  });
});

describe('hasActiveHostedWorkspaces', () => {
  it('is true only once a hosted workspace is stored', () => {
    expect(hasActiveHostedWorkspaces(dir)).toBe(false);
    writeTwentyWorkspace(dir, 'main', LOCAL_SETTINGS);
    expect(hasActiveHostedWorkspaces(dir)).toBe(false);
    writeTwentyWorkspace(dir, 'sales', HOSTED_SETTINGS);
    expect(hasActiveHostedWorkspaces(dir)).toBe(true);
  });

  it('counts a hosted workspace whose access is invalid', () => {
    writeTwentyWorkspace(dir, 'a', { ...HOSTED_SETTINGS, access: 'rw' });
    expect(hasActiveHostedWorkspaces(dir)).toBe(true);
  });
});

