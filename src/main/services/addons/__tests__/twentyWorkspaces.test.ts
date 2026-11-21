import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeStackFiles, type FakeStackFiles } from '../../stackHost/fakeStackFiles';
import {
  hasActiveHostedWorkspaces,
  listTwentyWorkspaces,
  localWorkspaceId,
  removeTwentyWorkspace,
  setTwentyWorkspaceAccess,
  setTwentyWorkspaceUrl,
  syncTwentyMcpFlag,
  twentySlugFree,
  writeTwentyWorkspace,
} from '../twentyWorkspaces';
import {
  HOSTED_SETTINGS,
  LOCAL_SETTINGS,
  signedInLocalSettings,
  type TwentyStoreSettings,
} from './twentyStoreFixtures';

const instance = (slug: string) => `userContent:addons/twenty/instances/${slug}.json`;
const secret = (slug: string, name: 'key_ro' | 'key_rw') => `userContent:addons/twenty/secrets/${slug}.${name}`;

let files: FakeStackFiles;

/** Stores a workspace as `crm.sh` writes it, with any keys given. */
function put(slug: string, settings: TwentyStoreSettings, keys: { keyRo?: string; keyRw?: string } = {}): void {
  files.files.set(instance(slug), `${JSON.stringify(settings, null, 2)}\n`);
  if (keys.keyRo !== undefined) files.files.set(secret(slug, 'key_ro'), keys.keyRo);
  if (keys.keyRw !== undefined) files.files.set(secret(slug, 'key_rw'), keys.keyRw);
}

const settingsOf = (slug: string): unknown => JSON.parse(files.files.get(instance(slug)) ?? 'null');

beforeEach(() => {
  files = createFakeStackFiles();
});

describe('listTwentyWorkspaces', () => {
  it('returns [] for a missing store', async () => {
    expect(await listTwentyWorkspaces(files)).toEqual([]);
  });

  it('reads a local workspace with both keys, defaulting access to read', async () => {
    put('main', signedInLocalSettings(), { keyRo: 'ro', keyRw: 'rw' });
    expect(await listTwentyWorkspaces(files)).toEqual([
      {
        slug: 'main',
        local: true,
        url: 'http://twenty-server:3000',
        workspaceUrl: 'http://localhost:3000/',
        access: 'read',
        skippedReason: null,
        hasReadKey: true,
        hasWriteKey: true,
      },
    ]);
  });

  it('reads a hosted workspace with write access and only a read-write key', async () => {
    put('work', { ...HOSTED_SETTINGS, access: 'write' }, { keyRw: 'rw' });
    expect((await listTwentyWorkspaces(files))[0]).toMatchObject({
      slug: 'work',
      local: false,
      url: 'https://crm.example.com',
      workspaceUrl: '',
      access: 'write',
      hasReadKey: false,
      hasWriteKey: true,
    });
  });

  it('counts an empty key file as absent', async () => {
    put('work', HOSTED_SETTINGS, { keyRo: '', keyRw: 'rw' });
    expect((await listTwentyWorkspaces(files))[0]).toMatchObject({ hasReadKey: false, hasWriteKey: true });
  });

  it('treats the twenty-server URL as local without the local flag, with a trailing slash or /mcp', async () => {
    put('a', { url: 'http://twenty-server:3000/mcp' });
    put('b', { url: 'http://twenty-server:3000/' });
    put('c', { url: 'https://c.example.com', local: true });
    put('d', { url: 'https://d.example.com' });
    expect((await listTwentyWorkspaces(files)).map((w) => [w.slug, w.local])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', false],
    ]);
  });

  it('never returns key values', async () => {
    put('main', LOCAL_SETTINGS, { keyRo: 'ro-secret-local', keyRw: 'rw-secret-local' });
    put('work', HOSTED_SETTINGS, { keyRo: 'ro-secret-hosted' });
    const json = JSON.stringify(await listTwentyWorkspaces(files));
    for (const value of ['ro-secret-local', 'rw-secret-local', 'ro-secret-hosted']) {
      expect(json).not.toContain(value);
    }
  });

  it('sorts local first, then by slug', async () => {
    put('zeta', HOSTED_SETTINGS);
    put('alpha', HOSTED_SETTINGS);
    put('main', LOCAL_SETTINGS);
    expect((await listTwentyWorkspaces(files)).map((w) => w.slug)).toEqual(['main', 'alpha', 'zeta']);
  });

  it('ignores other files, bad slugs and settings that are not a JSON object', async () => {
    put('work', HOSTED_SETTINGS);
    put('Bad', HOSTED_SETTINGS);
    put('9lives', HOSTED_SETTINGS);
    files.files.set(instance('broken'), '{ not json');
    files.files.set(instance('list'), '[]');
    files.files.set('userContent:addons/twenty/instances/notes.txt', 'ignored');
    expect((await listTwentyWorkspaces(files)).map((w) => w.slug)).toEqual(['work']);
  });

  it('flags an access that is neither read nor write, and still lists it', async () => {
    put('a', { ...HOSTED_SETTINGS, access: 'Read' });
    put('b', { ...HOSTED_SETTINGS, access: 'rw' });
    put('c', { ...HOSTED_SETTINGS, access: '' });
    put('d', { ...HOSTED_SETTINGS, access: 'write' });
    const byslug = Object.fromEntries((await listTwentyWorkspaces(files)).map((w) => [w.slug, w]));
    const reason = 'access must be read or write';
    expect(byslug.a).toMatchObject({ access: 'read', skippedReason: reason });
    expect(byslug.b).toMatchObject({ access: 'read', skippedReason: reason });
    expect(byslug.c).toMatchObject({ access: 'read', skippedReason: null });
    expect(byslug.d).toMatchObject({ access: 'write', skippedReason: null });
  });
});

describe('localWorkspaceId', () => {
  it('returns the stored id and address, defaulting to main', async () => {
    put('main', signedInLocalSettings());
    expect(await localWorkspaceId(files)).toEqual({ id: 'ws-1', workspaceUrl: 'http://localhost:3000/' });
  });

  it('reads another slug when given one', async () => {
    put('home', signedInLocalSettings('ws-2', 'http://localhost:3001/'));
    expect(await localWorkspaceId(files, 'home')).toEqual({ id: 'ws-2', workspaceUrl: 'http://localhost:3001/' });
  });

  it('returns null without a workspace or an id', async () => {
    expect(await localWorkspaceId(files)).toBeNull();
    put('main', LOCAL_SETTINGS);
    expect(await localWorkspaceId(files)).toBeNull();
  });
});

describe('setTwentyWorkspaceAccess', () => {
  it('rewrites only access, keeps the other settings and the keys, and leaves the file mode alone', async () => {
    const settings = { ...HOSTED_SETTINGS, workspace_url: 'https://crm.example.com/', access: 'read' };
    put('work', settings, { keyRo: 'ro', keyRw: 'rw' });
    await setTwentyWorkspaceAccess(files, 'work', 'write');
    expect(settingsOf('work')).toEqual({ ...settings, access: 'write' });
    expect(files.modes.has(instance('work'))).toBe(false);
    expect(await files.list('userContent', 'addons/twenty/instances')).toEqual(['work.json']);
    expect(files.files.get(secret('work', 'key_ro'))).toBe('ro');
    expect(files.files.get(secret('work', 'key_rw'))).toBe('rw');
  });

  it('adds access when the settings lack it', async () => {
    put('main', signedInLocalSettings(), { keyRo: 'ro' });
    await setTwentyWorkspaceAccess(files, 'main', 'read');
    expect(settingsOf('main')).toEqual({ ...signedInLocalSettings(), access: 'read' });
  });

  it('refuses read without a read-only key', async () => {
    put('work', HOSTED_SETTINGS, { keyRo: '', keyRw: 'rw' });
    await expect(setTwentyWorkspaceAccess(files, 'work', 'read')).rejects.toThrow(
      'crm-work has no read-only key. Connect it again with one.'
    );
  });

  it('refuses write without a read-write key and leaves the settings alone', async () => {
    const settings = { ...HOSTED_SETTINGS, access: 'read' };
    put('work', settings, { keyRo: 'ro' });
    await expect(setTwentyWorkspaceAccess(files, 'work', 'write')).rejects.toThrow(
      'crm-work has no read-write key. Connect it again with one.'
    );
    expect(settingsOf('work')).toEqual(settings);
  });

  it('refuses a workspace that is not stored, or a bad slug', async () => {
    await expect(setTwentyWorkspaceAccess(files, 'work', 'read')).rejects.toThrow(
      'crm-work has no workspace in the add-on store.'
    );
    await expect(setTwentyWorkspaceAccess(files, '../x', 'read')).rejects.toThrow(
      'crm-../x has no workspace in the add-on store.'
    );
    expect(files.files.size).toBe(0);
  });
});

describe('writeTwentyWorkspace', () => {
  it('writes the settings and both keys at mode 600 in folders of mode 700', async () => {
    await writeTwentyWorkspace(files, 'ada-family', { url: 'http://host.docker.internal:41000', access: 'read' }, { ro: 'r', rw: 'w' });
    expect(settingsOf('ada-family')).toEqual({ url: 'http://host.docker.internal:41000', access: 'read', local: false });
    expect(files.files.get(secret('ada-family', 'key_ro'))).toBe('r');
    expect(files.files.get(secret('ada-family', 'key_rw'))).toBe('w');
    for (const file of [instance('ada-family'), secret('ada-family', 'key_ro'), secret('ada-family', 'key_rw')]) {
      expect(files.modes.get(file)).toBe(0o600);
    }
    expect(files.modes.get('userContent:addons/twenty/instances')).toBe(0o700);
    expect(files.modes.get('userContent:addons/twenty/secrets')).toBe(0o700);
  });

  it('refuses a slug the stack would not accept and writes nothing', async () => {
    await expect(writeTwentyWorkspace(files, 'Bad', { url: 'u', access: 'read' }, { ro: 'r', rw: 'w' })).rejects.toThrow(
      'Bad isn’t a workspace name the stack accepts.'
    );
    expect(files.files.size).toBe(0);
  });
});

describe('twentySlugFree', () => {
  it('is true for a valid slug no workspace uses', async () => {
    put('work', HOSTED_SETTINGS);
    expect(await twentySlugFree(files, 'home')).toBe(true);
    expect(await twentySlugFree(files, 'work')).toBe(false);
    expect(await twentySlugFree(files, 'Bad')).toBe(false);
  });
});

describe('setTwentyWorkspaceUrl', () => {
  it('changes the URL and keeps the other settings', async () => {
    put('work', { ...HOSTED_SETTINGS, access: 'write' });
    await setTwentyWorkspaceUrl(files, 'work', 'http://host.docker.internal:41001');
    expect(settingsOf('work')).toEqual({ ...HOSTED_SETTINGS, access: 'write', url: 'http://host.docker.internal:41001' });
  });

  it('refuses a workspace that is not stored', async () => {
    await expect(setTwentyWorkspaceUrl(files, 'work', 'u')).rejects.toThrow('crm-work has no workspace in the add-on store.');
  });
});

describe('removeTwentyWorkspace', () => {
  it('deletes the settings and keys of that workspace only', async () => {
    put('work', HOSTED_SETTINGS, { keyRo: 'r', keyRw: 'w' });
    put('home', HOSTED_SETTINGS, { keyRw: 'w' });
    await removeTwentyWorkspace(files, 'work');
    expect([...files.files.keys()].sort()).toEqual([instance('home'), secret('home', 'key_rw')]);
  });

  it('ignores a bad slug', async () => {
    put('work', HOSTED_SETTINGS);
    await removeTwentyWorkspace(files, '../work');
    expect(files.files.has(instance('work'))).toBe(true);
  });
});

describe('hasActiveHostedWorkspaces', () => {
  it('is true only once a hosted workspace is stored', async () => {
    expect(await hasActiveHostedWorkspaces(files)).toBe(false);
    put('main', LOCAL_SETTINGS);
    expect(await hasActiveHostedWorkspaces(files)).toBe(false);
    put('sales', HOSTED_SETTINGS);
    expect(await hasActiveHostedWorkspaces(files)).toBe(true);
  });

  it('counts a hosted workspace whose access is invalid', async () => {
    put('a', { ...HOSTED_SETTINGS, access: 'rw' });
    expect(await hasActiveHostedWorkspaces(files)).toBe(true);
  });
});

describe('syncTwentyMcpFlag', () => {
  const ENV = 'stack:.env';

  it('turns MCP on in .env when a Circle workspace is written', async () => {
    files.files.set(ENV, 'TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
    await writeTwentyWorkspace(files, 'ada-family', { url: 'http://host.docker.internal:41000', access: 'read' }, { ro: 'r', rw: 'w' });
    expect(files.files.get(ENV)).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=1\n');
  });

  it('turns MCP off when the last hosted workspace goes and this Mac’s Twenty is off', async () => {
    files.files.set(ENV, 'TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=1\n');
    put('main', LOCAL_SETTINGS);
    put('work', HOSTED_SETTINGS);
    put('home', HOSTED_SETTINGS);
    await removeTwentyWorkspace(files, 'work');
    expect(files.files.get(ENV)).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=1\n');
    await removeTwentyWorkspace(files, 'home');
    expect(files.files.get(ENV)).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
  });

  it('keeps MCP on while .env has this Mac’s Twenty on', async () => {
    files.files.set(ENV, 'TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n');
    put('work', HOSTED_SETTINGS);
    await removeTwentyWorkspace(files, 'work');
    expect(files.files.get(ENV)).toBe('TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n');
  });

  it('adds the flag when .env lacks it, and does nothing without a .env', async () => {
    files.files.set(ENV, 'COMPOSE_PROFILES=core\n');
    put('work', HOSTED_SETTINGS);
    await syncTwentyMcpFlag(files);
    expect(files.files.get(ENV)).toBe('COMPOSE_PROFILES=core\nTWENTY_MCP_ENABLED=1\n');
    files.files.delete(ENV);
    await syncTwentyMcpFlag(files);
    expect(files.files.has(ENV)).toBe(false);
  });
});
