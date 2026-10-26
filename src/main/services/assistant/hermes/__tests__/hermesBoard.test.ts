import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BASE = 'http://127.0.0.1:9119';
const SECRET = 's'.repeat(40);

const cookieJar = { get: vi.fn(), set: vi.fn() };
const openExternal = vi.fn(() => Promise.resolve());
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn(() => ({ cookies: cookieJar })) },
  shell: { openExternal: (url: string) => openExternal(url) },
}));

const login = vi.fn();
vi.mock('../hermesDashboardAuth', () => ({ loginToDashboard: () => login() }));

let handoffSecret: string | null = null;
vi.mock('../hermesEndpoints', () => ({
  resolveHermesStackEndpoints: () => ({ dashboardBaseUrl: BASE }),
  resolveDashboardHandoffSecret: () => handoffSecret,
}));

vi.mock('../hermesKanban', () => ({
  currentBoardSlug: () => Promise.resolve('default'),
  validTaskId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id),
}));

import {
  BOARD_PARTITION,
  installBoardWebviewGuards,
  openBoardInBrowser,
  prepareBoardView,
} from '../hermesBoard';
import { boardPath, browserUrlFor, isBoardUrl, mintHandoffCode } from '../hermesBoardLinks';

function decodePayload(code: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(code.split('.')[0], 'base64url').toString('utf8'));
}

beforeEach(() => {
  cookieJar.get.mockReset();
  cookieJar.set.mockReset();
  openExternal.mockClear();
  login.mockReset();
  handoffSecret = null;
});

describe('board links', () => {
  it('builds the board path, embedded or not, on a task and its board', () => {
    expect(boardPath({ embed: false })).toBe('/kanban');
    expect(boardPath({ embed: true })).toBe('/kanban?embed=1');
    expect(boardPath({ embed: true, taskId: 't_1', board: 'default' })).toBe(
      '/kanban?embed=1&task=t_1&board=default'
    );
    expect(boardPath({ embed: false, board: 'default' })).toBe('/kanban');
  });

  it('mints the stack\'s v1 handoff code: base64url payload, HMAC-SHA256 signature', () => {
    const code = mintHandoffCode(SECRET, '/kanban?task=t_1', 1_800_000_000, 'n'.repeat(24));
    const [payload, signature] = code.split('.');
    expect(decodePayload(code)).toEqual({
      v: 1,
      nonce: 'n'.repeat(24),
      exp: 1_800_000_030,
      next: '/kanban?task=t_1',
    });
    expect(signature).toBe(crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'));
    expect(code).not.toContain('=');
  });

  it('opens the browser with a sign-in link only when the stack has a secret', () => {
    expect(browserUrlFor(BASE, '/kanban', null, 1)).toBe(`${BASE}/kanban`);
    const url = new URL(browserUrlFor(BASE, '/kanban', SECRET, 1));
    expect(url.pathname).toBe('/auth/handoff');
    expect(decodePayload(url.searchParams.get('code') ?? '').next).toBe('/kanban');
  });

  it('treats only the dashboard\'s /kanban as the board', () => {
    expect(isBoardUrl(`${BASE}/kanban?embed=1`, BASE)).toBe(true);
    expect(isBoardUrl(`${BASE}/kanban/archive`, BASE)).toBe(true);
    expect(isBoardUrl(`${BASE}/config`, BASE)).toBe(false);
    expect(isBoardUrl(`${BASE}/kanbanx`, BASE)).toBe(false);
    expect(isBoardUrl('http://127.0.0.1:9999/kanban', BASE)).toBe(false);
    expect(isBoardUrl('not a url', BASE)).toBe(false);
  });

  it('opens a task in the browser on Hermes\'s current board', async () => {
    handoffSecret = SECRET;
    await openBoardInBrowser('t_1');
    const url = new URL(openExternal.mock.calls[0][0] as string);
    expect(decodePayload(url.searchParams.get('code') ?? '').next).toBe('/kanban?task=t_1&board=default');
  });
});

describe('prepareBoardView', () => {
  it('signs the board partition in with the dashboard\'s cookies and attributes', async () => {
    cookieJar.get.mockResolvedValue([]);
    login.mockResolvedValue({
      cookieHeader: 'at=a; rt=r',
      dashboardBaseUrl: BASE,
      cookies: [
        { name: 'at', value: 'a', path: '/', httpOnly: true, secure: false, sameSite: 'lax', maxAgeS: 3600 },
        { name: 'rt', value: 'r', path: '/', httpOnly: true, secure: false, sameSite: 'lax', maxAgeS: null },
      ],
    });
    const result = await prepareBoardView('t_1');
    expect(result).toEqual({
      success: true,
      url: `${BASE}/kanban?embed=1&task=t_1&board=default`,
      partition: BOARD_PARTITION,
    });
    expect(cookieJar.set).toHaveBeenCalledTimes(2);
    expect(cookieJar.set.mock.calls[0][0]).toMatchObject({
      url: BASE,
      name: 'at',
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(cookieJar.set.mock.calls[0][0].expirationDate).toBeGreaterThan(Date.now() / 1000);
    expect(cookieJar.set.mock.calls[1][0]).not.toHaveProperty('expirationDate');
  });

  it('reuses a signed-in partition and ignores a malformed task id', async () => {
    cookieJar.get.mockResolvedValue([{ name: 'at' }]);
    const result = await prepareBoardView('../config');
    expect(login).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, url: `${BASE}/kanban?embed=1` });
  });

  it('says why when the dashboard refuses the sign-in', async () => {
    cookieJar.get.mockResolvedValue([]);
    login.mockRejectedValue(new Error('Dashboard credentials missing.'));
    expect(await prepareBoardView(null)).toEqual({
      success: false,
      error: 'Dashboard credentials missing.',
    });
  });
});

class FakeContents extends EventEmitter {
  openHandler: ((d: { url: string }) => { action: string }) | null = null;
  loadURL = vi.fn(() => Promise.resolve());
  navigationHistory = { canGoBack: () => true, goBack: vi.fn() };
  setWindowOpenHandler(h: (d: { url: string }) => { action: string }): void {
    this.openHandler = h;
  }
}

function attach(): { win: EventEmitter; contents: FakeContents } {
  const win = new EventEmitter();
  installBoardWebviewGuards({ webContents: win } as never);
  const contents = new FakeContents();
  win.emit('did-attach-webview', {}, contents);
  return { win, contents };
}

describe('board webview guards', () => {
  it('attaches only the board, on its partition, without a preload', () => {
    const { win } = attach();
    const ok = { preventDefault: vi.fn() };
    const prefs: Record<string, unknown> = { preload: '/app/preload.js', nodeIntegration: true };
    win.emit('will-attach-webview', ok, prefs, { partition: BOARD_PARTITION, src: `${BASE}/kanban?embed=1` });
    expect(ok.preventDefault).not.toHaveBeenCalled();
    expect(prefs).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });

    const wrongPartition = { preventDefault: vi.fn() };
    win.emit('will-attach-webview', wrongPartition, {}, { partition: '', src: `${BASE}/kanban` });
    expect(wrongPartition.preventDefault).toHaveBeenCalled();
    const wrongPage = { preventDefault: vi.fn() };
    win.emit('will-attach-webview', wrongPage, {}, { partition: BOARD_PARTITION, src: `${BASE}/config` });
    expect(wrongPage.preventDefault).toHaveBeenCalled();
  });

  it('sends other dashboard pages and new windows to the browser', () => {
    handoffSecret = SECRET;
    const { contents } = attach();
    const stay = { preventDefault: vi.fn() };
    contents.emit('will-navigate', stay, `${BASE}/kanban?task=t_2`);
    expect(stay.preventDefault).not.toHaveBeenCalled();

    const leave = { preventDefault: vi.fn() };
    contents.emit('will-navigate', leave, `${BASE}/config`);
    expect(leave.preventDefault).toHaveBeenCalled();
    const url = new URL(openExternal.mock.calls[0][0] as string);
    expect(decodePayload(url.searchParams.get('code') ?? '').next).toBe('/config');

    expect(contents.openHandler?.({ url: 'https://example.com/doc' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenLastCalledWith('https://example.com/doc');
    contents.openHandler?.({ url: 'file:///etc/passwd' });
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('undoes a client-side route away from the board', () => {
    const { contents } = attach();
    contents.emit('did-navigate-in-page', {}, `${BASE}/sessions`, true);
    expect(openExternal).toHaveBeenCalledWith(`${BASE}/sessions`);
    expect(contents.navigationHistory.goBack).toHaveBeenCalled();
  });

  it('signs in again and returns to the board when the dashboard asks for a login', async () => {
    cookieJar.get.mockResolvedValue([]);
    login.mockResolvedValue({ cookieHeader: '', dashboardBaseUrl: BASE, cookies: [] });
    const { contents } = attach();
    contents.emit('did-navigate', {}, `${BASE}/kanban?embed=1&task=t_1`);
    contents.emit('did-navigate', {}, `${BASE}/login?next=%2Fkanban`);
    await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledWith(`${BASE}/kanban?embed=1&task=t_1`));
    contents.emit('did-navigate', {}, `${BASE}/login?next=%2Fkanban`);
    expect(login).toHaveBeenCalledTimes(1);
  });
});
