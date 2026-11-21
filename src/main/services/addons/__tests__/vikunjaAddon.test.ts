import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlainOutcome } from '../addonScript';
import {
  copyVikunjaPassword,
  createVikunjaService,
  loopbackWebUrl,
  parseVikunjaListing,
  readVikunjaEnabled,
  readVikunjaLogin,
  vikunjaAccount,
  vikunjaAvailable,
  vikunjaDataLeft,
} from '../vikunjaAddon';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { localStackFiles } from '../../stackHost/localStackHost';
import { fakeSecretClipboard } from './secretClipboardFake';

// `addon.sh list --json` as the stack's main (c1bb98a) prints it: an array of listings
// (scripts/lib/addon_store.py `listing`), with `web` from `web_view`: url
// http://localhost:<published port><path>, or null while the gate is off or the port isn't
// published. Other fields are left out.
const listing = (fields: Record<string, unknown>) =>
  JSON.stringify([
    { shortId: 'email', enabled: false, web: null },
    { shortId: 'vikunja', title: 'Todo lists', enabled: true, web: { service: 'proxy', path: '/login-local', url: 'http://localhost:3456/login-local' }, ...fields },
  ]);

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('vikunjaAvailable', () => {
  const files = (manifest: unknown, addonSh = true) =>
    createFakeStackFiles({
      ...(manifest === null ? {} : { 'stack:addons/vikunja/addon.json': typeof manifest === 'string' ? manifest : JSON.stringify(manifest) }),
      ...(addonSh ? { 'stack:scripts/addon.sh': '#!/bin/bash' } : {}),
    });

  it('needs the manifest with the prepare hook (stack 0.3.15)', async () => {
    expect(await vikunjaAvailable(files({ hooks: { prepare: { script: ['scripts/todo.sh', 'prepare'] }, init: {} } }))).toBe(true);
    expect(await vikunjaAvailable(files({ hooks: { init: {} } }))).toBe(false);
    expect(await vikunjaAvailable(files(null))).toBe(false);
    expect(await vikunjaAvailable(files({ hooks: { prepare: {} } }, false))).toBe(false);
    expect(await vikunjaAvailable(files('not json'))).toBe(false);
  });
});

describe('readVikunjaEnabled', () => {
  it('reads VIKUNJA_MCP_ENABLED from the stack .env', async () => {
    const stackFiles = localStackFiles({ stackRoot: root, userContentRoot: () => path.join(root, 'data') });
    fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=1\n');
    expect(await readVikunjaEnabled(stackFiles)).toBe(true);
    fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=0\n');
    expect(await readVikunjaEnabled(stackFiles)).toBe(false);
  });
});

describe('vikunjaDataLeft', () => {
  const dataRoot = () => path.join(root, 'data');
  const files = () => localStackFiles({ stackRoot: root, userContentRoot: dataRoot });
  const initDone = () => {
    fs.mkdirSync(path.join(dataRoot(), 'addons', 'vikunja'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot(), 'addons', 'vikunja', 'state.json'), JSON.stringify({ init: { version: '1.0.0', at: 'x' } }));
  };

  it('needs both the files folder and a recorded init', async () => {
    expect(await vikunjaDataLeft(files(), root)).toBe(false);
    // prepare made the folder, then the first Get failed before init.
    fs.mkdirSync(path.join(root, 'data', 'vikunja', 'files'), { recursive: true });
    expect(await vikunjaDataLeft(files(), root)).toBe(false);
    initDone();
    expect(await vikunjaDataLeft(files(), root)).toBe(true);
    // remove --delete-data deletes the folder and keeps state.json.
    fs.rmSync(path.join(root, 'data', 'vikunja'), { recursive: true });
    expect(await vikunjaDataLeft(files(), root)).toBe(false);
  });

  it('follows VIKUNJA_FILES_DIR', async () => {
    initDone();
    fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_FILES_DIR=./elsewhere/files\n');
    fs.mkdirSync(path.join(root, 'elsewhere', 'files'), { recursive: true });
    expect(await vikunjaDataLeft(files(), root)).toBe(true);
  });
});

describe('parseVikunjaListing', () => {
  it('reads enabled and web.url from the vikunja entry', () => {
    expect(parseVikunjaListing(listing({}))).toEqual({ enabled: true, webUrl: 'http://localhost:3456/login-local' });
    expect(parseVikunjaListing(listing({ enabled: false, web: { service: 'proxy', path: '/login-local', url: null } }))).toEqual({
      enabled: false,
      webUrl: null,
    });
  });

  it('is null without a vikunja entry or with output that isn’t a list', () => {
    expect(parseVikunjaListing('[]')).toBeNull();
    expect(parseVikunjaListing('{}')).toBeNull();
    expect(parseVikunjaListing('warning: oops')).toBeNull();
  });
});

describe('loopbackWebUrl', () => {
  it('accepts http on localhost or 127.0.0.1 with a port', () => {
    expect(loopbackWebUrl('http://localhost:3456/login-local')).toBe('http://localhost:3456/login-local');
    expect(loopbackWebUrl('http://127.0.0.1:4000/login-local')).toBe('http://127.0.0.1:4000/login-local');
  });

  it('refuses anything else', () => {
    for (const url of [
      'http://example.com:3456/login-local',
      'http://192.168.1.4:3456/login-local',
      'https://localhost:3456/',
      'http://localhost/login-local',
      'http://user:pw@localhost:3456/',
      'file:///etc/passwd',
      'not a url',
      null,
    ]) {
      expect(loopbackWebUrl(url)).toBeNull();
    }
  });
});

describe('webUrl', () => {
  const service = (outcome: PlainOutcome) =>
    createVikunjaService({
      paths: () => ({ root, dataRoot: root }),
      plain: async () => outcome,
      run: async () => {
        throw new Error('not used');
      },
      log: () => undefined,
    });
  const ok = (stdout: string): PlainOutcome => ({ code: 0, stdout, stderrTail: [] });

  it('gives the listed URL while it is on', async () => {
    expect(await service(ok(listing({}))).webUrl()).toEqual({ url: 'http://localhost:3456/login-local' });
  });

  it('explains why it can’t open', async () => {
    expect(await service({ code: 1, stdout: '', stderrTail: [] }).webUrl()).toEqual({ error: expect.stringContaining('code 1') });
    expect(await service(ok('[]')).webUrl()).toEqual({ error: 'The stack doesn’t list Todo lists.' });
    expect(await service(ok(listing({ enabled: false }))).webUrl()).toEqual({ error: expect.stringContaining('is off') });
    expect(await service(ok(listing({ web: { service: 'proxy', path: '/login-local', url: null } }))).webUrl()).toEqual({
      error: expect.stringContaining('no published port'),
    });
    expect(
      await service(ok(listing({ web: { service: 'proxy', path: '/login-local', url: 'http://10.0.0.2:3456/login-local' } }))).webUrl()
    ).toEqual({ error: expect.stringContaining('outside this Mac') });
  });
});

// `todo.sh init` (stack v0.3.15, lines 161-162) writes both keys with upsert_env; `addon.sh remove`
// leaves them in .env.
describe('the managed Vikunja login', () => {
  const env = (lines: string) => createFakeStackFiles({ 'stack:.env': lines });
  const ON = 'VIKUNJA_MCP_ENABLED=1\nVIKUNJA_USERNAME=me\nVIKUNJA_PASSWORD=s3cret-gen\n';

  it('reads the username and password todo.sh init wrote', async () => {
    expect(await readVikunjaLogin(env(ON))).toEqual({ username: 'me', password: 's3cret-gen' });
  });

  it('has none while Todo lists is off, even with the keys left behind', async () => {
    expect(await readVikunjaLogin(env(ON.replace('ENABLED=1', 'ENABLED=0')))).toBeNull();
  });

  it('has none before init writes both keys', async () => {
    expect(await readVikunjaLogin(env('VIKUNJA_MCP_ENABLED=1\nVIKUNJA_USERNAME=me\n'))).toBeNull();
    expect(await readVikunjaLogin(env('VIKUNJA_MCP_ENABLED=1\nVIKUNJA_PASSWORD=x\n'))).toBeNull();
    expect(await readVikunjaLogin(createFakeStackFiles({}))).toBeNull();
  });

  it('gives the renderer the username only', async () => {
    const account = await vikunjaAccount(env(ON));
    expect(account).toEqual({ username: 'me' });
    expect(JSON.stringify(account)).not.toContain('s3cret-gen');
  });

  it('copies the password, cleared after 60 s', async () => {
    const clipboard = fakeSecretClipboard();
    const setTimer = vi.fn();
    expect(await copyVikunjaPassword({ files: env(ON), clipboard, setTimer })).toBe(true);
    expect(clipboard.writeSecret).toHaveBeenCalledWith('s3cret-gen');
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });

  it('copies nothing without a login', async () => {
    const clipboard = fakeSecretClipboard();
    expect(await copyVikunjaPassword({ files: env(''), clipboard })).toBe(false);
    expect(clipboard.writeSecret).not.toHaveBeenCalled();
  });
});
