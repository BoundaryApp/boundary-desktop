import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slugFromName } from '../../../../shared/actualSlug';
import {
  actualAvailable,
  actualConnectInput,
  actualOpenUrl,
  actualServerInput,
  createActualService,
  readActualFlags,
  readActualRows,
  type ActualService,
} from '../actualAddon';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { createActualFakeStack, type ActualFakeStack } from './actualFake';

let stack: ActualFakeStack;
let service: ActualService;
let logs: { message: string; data: Record<string, unknown> }[];

beforeEach(() => {
  stack = createActualFakeStack();
  logs = [];
  service = createActualService({
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    files: stack.files,
    run: (script, args, options) => stack.run(script, args, options),
    exclusive: (work) => work(),
    log: (message, data) => logs.push({ message, data }),
  });
});

afterEach(() => stack.cleanup());

const remote = {
  server: 'https://budget.example.com',
  password: 'right-password',
  slug: 'home',
  syncId: 'home-1',
  access: 'read' as const,
  replace: false,
};

describe('connect', () => {
  it('turns the add-on on first, then connects with the credential on stdin and no bind for Look things up', async () => {
    const result = await service.connect(remote);
    expect(result).toEqual({ ok: true, mcp: ['budget-home'] });
    expect(stack.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['enable actual', 'connect actual']);
    const connect = stack.calls[1]!;
    expect(connect.args).toEqual(['connect', 'actual', '--instance', 'home', '--json']);
    expect(connect.input).toEqual({
      server: 'https://budget.example.com',
      password: 'right-password',
      sync_id: 'home-1',
    });
    expect(connect.args.join(' ')).not.toContain('right-password');
    expect((await service.overview()).budgets).toEqual([
      { slug: 'home', server: 'https://budget.example.com', local: false, syncId: 'home-1', access: 'read', state: 'ok' },
    ]);
  });

  it('sends the write bind for Make changes, which the row then reads back as write', async () => {
    expect(await service.connect({ ...remote, access: 'write' })).toEqual({ ok: true, mcp: ['budget-home'] });
    expect(stack.calls.at(-1)!.input).toMatchObject({ bind: { default: 'rw', browser: 'rw', 'api-server': 'ro' } });
    expect(stack.calls.at(-1)!.input).not.toHaveProperty('access');
    expect((await service.overview()).budgets[0]!.access).toBe('write');
  });

  it('sends only the session token when one is given', async () => {
    await service.connect({ ...remote, password: undefined, sessionToken: 'good-token' });
    expect(stack.calls.at(-1)!.input).toMatchObject({ session_token: 'good-token' });
    expect(stack.calls.at(-1)!.input).not.toHaveProperty('password');
  });

  it('skips enable when the add-on is already on', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1' });
    await service.connect(remote);
    expect(stack.calls.map((c) => c.args[0])).toEqual(['connect']);
  });

  it('stops when enable fails, without connecting', async () => {
    stack.override = (_s, args) =>
      args[0] === 'enable'
        ? { kind: 'error', error: 'compose_failed', message: 'docker compose up failed', step: 'start', logTail: [], lines: [] }
        : null;
    expect(await service.connect(remote)).toEqual({ ok: false, error: 'compose_failed', message: 'docker compose up failed' });
    expect(stack.calls.map((c) => c.args[0])).toEqual(['enable']);
  });

  it.each([
    ['login_refused', { password: 'wrong' }],
    ['token_expired', { password: undefined, sessionToken: 'old-token' }],
    ['no_access', { syncId: 'someone-elses' }],
    ['encryption_password', { syncId: 'vault-1' }],
    ['server_unreachable', { server: 'https://down.example.com' }],
  ])('passes %s through by name, and writes nothing', async (name, change) => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1' });
    const result = await service.connect({ ...remote, ...change });
    expect(result).toMatchObject({ ok: false, error: name });
    expect(stack.rows()).toEqual([]);
  });

  it('passes exists, bad_slug, bad_input and timeout through by name', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1' });
    stack.addRow('home', { server: 'local', sync_id: 'local-1' });
    expect(await service.connect(remote)).toMatchObject({ ok: false, error: 'exists' });
    expect(await service.connect({ ...remote, slug: '9lives' })).toMatchObject({ ok: false, error: 'bad_slug' });
    for (const name of ['bad_input', 'timeout']) {
      stack.override = () => ({ kind: 'error', error: name, message: 'from the hook', step: 'check', logTail: [], lines: [] });
      expect(await service.connect({ ...remote, slug: 'other' })).toEqual({ ok: false, error: name, message: 'from the hook' });
    }
  });

  it('reports an exit with no done line as command_failed', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1' });
    stack.override = () => ({ kind: 'exited', code: 1, logTail: ['bash: python3: command not found'], lines: [] });
    expect(await service.connect(remote)).toEqual({
      ok: false,
      error: 'command_failed',
      message: 'the script exited with code 1 and no result: bash: python3: command not found',
    });
  });

  it('replaces by disconnecting first, since connect has no --force', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1' });
    stack.addRow('home', { server: 'https://budget.example.com', sync_id: 'home-1', bind: { default: 'rw', browser: 'rw', 'api-server': 'ro' } });
    expect(await service.connect({ ...remote, replace: true })).toMatchObject({ ok: true });
    expect(stack.calls.map((c) => c.args[0])).toEqual(['disconnect', 'connect']);
  });

  it('replaces a row that is already gone', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: '1' });
    expect(await service.connect({ ...remote, replace: true })).toMatchObject({ ok: true });
  });

  it('logs metadata only', async () => {
    await service.connect({ ...remote, encryptionPassword: 'enc-pass' });
    const text = JSON.stringify(logs);
    for (const secret of ['right-password', 'enc-pass', 'home-1', 'budget.example.com']) expect(text).not.toContain(secret);
  });
});

describe('status', () => {
  it('keeps each row’s state, and marks this Mac’s rows while its server is off', async () => {
    stack.addRow('home', { server: 'https://budget.example.com', sync_id: 'home-1' });
    stack.addRow('mac', { server: 'local', sync_id: 'local-1', bind: { default: 'rw', browser: 'rw', 'api-server': 'ro' } });
    stack.addRow('odd', { server: 'https://budget.example.com', sync_id: 'x' });
    stack.states = { home: 'token_expired', odd: 'something_new' };
    const overview = await service.refreshStatus();
    expect(overview.budgets.map((b) => [b.slug, b.state])).toEqual([
      ['home', 'token_expired'],
      ['mac', 'server_off'],
      ['odd', 'unknown'],
    ]);
    stack.setEnv({ ACTUAL_LOCAL_ENABLED: '1' });
    expect((await service.overview()).budgets.find((b) => b.slug === 'mac')!.state).toBe('ok');
  });

  it('says why status failed and keeps the states it had', async () => {
    stack.addRow('home', { server: 'https://budget.example.com', sync_id: 'home-1' });
    await service.refreshStatus();
    stack.override = () => ({ kind: 'exited', code: 127, logTail: [], lines: [] });
    const overview = await service.refreshStatus();
    expect(overview.statusError).toBe('bash couldn’t start the script');
    expect(overview.budgets[0]!.state).toBe('ok');
  });
});

describe('serverBudgets', () => {
  it('lists the budgets a password opens', async () => {
    expect(await service.serverBudgets({ server: 'https://budget.example.com', password: 'right-password' })).toEqual({
      ok: true,
      budgets: [
        { syncId: 'home-1', name: 'Home', encrypted: false },
        { syncId: 'vault-1', name: 'Vault', encrypted: true },
      ],
    });
  });

  it('passes a refused password through', async () => {
    expect(await service.serverBudgets({ server: 'https://budget.example.com', password: 'nope' })).toMatchObject({
      ok: false,
      error: 'login_refused',
    });
  });

  it('sends only the server for this Mac', async () => {
    await service.serverBudgets({ server: 'local' });
    expect(stack.calls[0]!.input).toEqual({ server: 'local' });
  });
});

describe('access and disconnect', () => {
  beforeEach(() => {
    stack.addRow('home', { server: 'https://budget.example.com', sync_id: 'home-1' });
  });

  it('changes access with budget.sh access and returns the one entry', async () => {
    expect(await service.setAccess('home', 'write')).toEqual({ ok: true, mcp: ['budget-home'] });
    expect(stack.calls[0]!.args).toEqual(['access', 'home', 'write', '--json']);
    expect((await service.overview()).budgets[0]!.access).toBe('write');
    expect(await service.setAccess('home', 'read')).toEqual({ ok: true, mcp: ['budget-home'] });
    expect((await service.overview()).budgets[0]!.access).toBe('read');
  });

  it('disconnects, and reports an unknown slug by name', async () => {
    expect(await service.disconnect('home')).toEqual({ ok: true });
    expect(stack.rows()).toEqual([]);
    expect(await service.disconnect('home')).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('input from the renderer', () => {
  it('needs an http(s) address and a credential for another server', () => {
    expect(() => actualServerInput({})).toThrow('http:// or https://');
    expect(() => actualServerInput({ server: 'budget.example.com', password: 'x' })).toThrow('http:// or https://');
    expect(() => actualServerInput({ server: 'https://budget.example.com' })).toThrow('password or a session token');
    expect(actualServerInput({ server: 'local' })).toEqual({ server: 'local' });
  });

  it('checks every connect field', () => {
    const good = { server: 'local', slug: 'home', syncId: 's', access: 'read', replace: false };
    expect(actualConnectInput(good)).toEqual(good);
    expect(() => actualConnectInput(undefined)).toThrow();
    expect(() => actualConnectInput({ ...good, slug: 'Home' })).toThrow('lowercase');
    expect(() => actualConnectInput({ ...good, syncId: ' ' })).toThrow('Pick a budget');
    expect(() => actualConnectInput({ ...good, access: 'admin' })).toThrow('read or write');
    expect(() => actualConnectInput({ ...good, replace: 'yes' })).toThrow('replace');
    expect(actualConnectInput({ ...good, encryptionPassword: '' })).not.toHaveProperty('encryptionPassword');
  });
});

describe('the stack’s files', () => {
  it('reads the flags, with the default port for a bad one', async () => {
    stack.setEnv({ ACTUAL_MCP_ENABLED: 'true', ACTUAL_LOCAL_ENABLED: '0', ACTUAL_PORT: 'x' });
    expect(await readActualFlags(stack.files)).toEqual({ enabled: true, local: false, port: 5006 });
  });

  it('reads write access from bind.default only, ignoring an older row’s access field', async () => {
    stack.addRow('a', { server: 'local', sync_id: 's', bind: { default: 'rw', browser: 'rw', 'api-server': 'ro' } });
    stack.addRow('b', { server: 'local', sync_id: 's', access: 'write', profile: 'default' });
    stack.addRow('c', { server: 'local', sync_id: 's', bind: { default: 'ro', browser: 'rw' } });
    stack.addRow('d', { server: 'local', sync_id: 's', bind: ['rw'] });
    expect((await readActualRows(stack.files)).map((r) => [r.slug, r.access])).toEqual([
      ['a', 'write'],
      ['b', 'read'],
      ['c', 'read'],
      ['d', 'read'],
    ]);
  });

  it('skips index files with a bad name or bad JSON', async () => {
    stack.addRow('ok', { server: 'local', sync_id: 's', bind: { default: 'rw' } });
    fs.writeFileSync(path.join(stack.dataRoot, 'addons', 'actual', 'instances', 'Bad.json'), '{}');
    fs.writeFileSync(path.join(stack.dataRoot, 'addons', 'actual', 'instances', 'broken.json'), '{');
    expect(await readActualRows(stack.files)).toEqual([
      { slug: 'ok', server: 'local', local: true, syncId: 's', access: 'write' },
    ]);
  });

  it('finds the add-on only with addon.sh and a manifest that has both hooks', async () => {
    const files = createFakeStackFiles();
    expect(await actualAvailable(files)).toBe(false);
    files.files.set('stack:scripts/addon.sh', '#!');
    files.files.set('stack:addons/actual/addon.json', JSON.stringify({ hooks: {} }));
    expect(await actualAvailable(files)).toBe(false);
    files.files.set('stack:addons/actual/addon.json', JSON.stringify({ hooks: { init: {} }, instances: { connect: {} } }));
    expect(await actualAvailable(files)).toBe(true);
  });

  it('opens this Mac’s port, or a row’s own http(s) server', () => {
    expect(actualOpenUrl(null, 'http://localhost:5006')).toBe('http://localhost:5006');
    expect(actualOpenUrl({ local: false, server: 'https://budget.example.com' }, 'http://localhost:5006')).toBe('https://budget.example.com/');
    expect(actualOpenUrl({ local: false, server: 'file:///etc' }, 'http://localhost:5006')).toBeNull();
  });
});

describe('slugFromName', () => {
  it.each([
    ['Budget', 'budget'],
    ['Family Budget 2026', 'family-budget-2026'],
    ['Café & Bills', 'cafe-bills'],
    ['2026 plan', 'plan'],
    ['!!!', 'budget'],
    ['a'.repeat(40), 'a'.repeat(31)],
    ['Crème Brûlée', 'creme-brulee'],
    ['9 lives', 'lives'],
    ['--Ärger--', 'arger'],
    ['Ångström'.repeat(5), 'angstromangstromangstromangstro'],
    ['a1-'.repeat(15), 'a1-a1-a1-a1-a1-a1-a1-a1-a1-a1-a'],
    ['日本語', 'budget'],
    ['ﬁnance', 'finance'],
  ])('%s → %s', (name, slug) => {
    expect(slugFromName(name)).toBe(slug);
  });
});
