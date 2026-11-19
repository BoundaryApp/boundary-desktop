import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlainOutcome } from '../addonScript';
import {
  createVikunjaService,
  loopbackWebUrl,
  parseVikunjaListing,
  readVikunjaEnabled,
  vikunjaAvailable,
  vikunjaDataLeft,
} from '../vikunjaAddon';

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
  const files = (manifest: unknown, addonSh = true) => (p: string) =>
    p.endsWith('addon.json') ? (manifest === null ? null : JSON.stringify(manifest)) : addonSh ? '#!/bin/bash' : null;

  it('needs the manifest with the prepare hook (stack 0.3.15)', () => {
    expect(vikunjaAvailable('/s', files({ hooks: { prepare: { script: ['scripts/todo.sh', 'prepare'] }, init: {} } }))).toBe(true);
    expect(vikunjaAvailable('/s', files({ hooks: { init: {} } }))).toBe(false);
    expect(vikunjaAvailable('/s', files(null))).toBe(false);
    expect(vikunjaAvailable('/s', files({ hooks: { prepare: {} } }, false))).toBe(false);
    expect(vikunjaAvailable('/s', () => 'not json')).toBe(false);
  });
});

describe('readVikunjaEnabled', () => {
  it('reads VIKUNJA_MCP_ENABLED from the stack .env', () => {
    fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=1\n');
    expect(readVikunjaEnabled(root)).toBe(true);
    fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_MCP_ENABLED=0\n');
    expect(readVikunjaEnabled(root)).toBe(false);
  });
});

describe('vikunjaDataLeft', () => {
  const dataRoot = () => path.join(root, 'data');
  const initDone = () => {
    fs.mkdirSync(path.join(dataRoot(), 'addons', 'vikunja'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot(), 'addons', 'vikunja', 'state.json'), JSON.stringify({ init: { version: '1.0.0', at: 'x' } }));
  };

  it('needs both the files folder and a recorded init', () => {
    expect(vikunjaDataLeft(root, dataRoot())).toBe(false);
    // prepare made the folder, then the first Get failed before init.
    fs.mkdirSync(path.join(root, 'data', 'vikunja', 'files'), { recursive: true });
    expect(vikunjaDataLeft(root, dataRoot())).toBe(false);
    initDone();
    expect(vikunjaDataLeft(root, dataRoot())).toBe(true);
    // remove --delete-data deletes the folder and keeps state.json.
    fs.rmSync(path.join(root, 'data', 'vikunja'), { recursive: true });
    expect(vikunjaDataLeft(root, dataRoot())).toBe(false);
  });

  it('follows VIKUNJA_FILES_DIR', () => {
    initDone();
    fs.writeFileSync(path.join(root, '.env'), 'VIKUNJA_FILES_DIR=./elsewhere/files\n');
    fs.mkdirSync(path.join(root, 'elsewhere', 'files'), { recursive: true });
    expect(vikunjaDataLeft(root, dataRoot())).toBe(true);
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
