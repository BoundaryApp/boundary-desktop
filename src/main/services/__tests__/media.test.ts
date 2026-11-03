import { ipcMain, systemPreferences, type Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appUrlMatcher } from '../../appUrl';
import { getMediaAccess, installPermissionHandlers, registerMediaHandlers, requestMediaAccess } from '../media';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
    askForMediaAccess: vi.fn(),
  },
}));

const getStatus = vi.mocked(systemPreferences.getMediaAccessStatus);
const askForAccess = vi.mocked(systemPreferences.askForMediaAccess);

const APP_FILE = 'file:///Applications/Boundary.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html';

type RequestHandler = Parameters<Session['setPermissionRequestHandler']>[0] & {};
type CheckHandler = Parameters<Session['setPermissionCheckHandler']>[0] & {};

function install(appUrl: string) {
  const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
  installPermissionHandlers(session as unknown as Session, appUrlMatcher(new URL(appUrl)));
  const onRequest = session.setPermissionRequestHandler.mock.calls[0][0] as RequestHandler;
  const onCheck = session.setPermissionCheckHandler.mock.calls[0][0] as CheckHandler;
  return {
    request(permission: string, details: Record<string, unknown>): boolean {
      const callback = vi.fn();
      onRequest(
        {} as never,
        permission as never,
        callback,
        { isMainFrame: true, ...details } as never
      );
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0] as boolean;
    },
    check(permission: string, details: Record<string, unknown>): boolean {
      return onCheck(null, permission as never, '', { isMainFrame: true, ...details } as never);
    },
  };
}

describe('installPermissionHandlers', () => {
  it('grants audio and video to the packaged app page', () => {
    const { request } = install(APP_FILE);
    expect(request('media', { requestingUrl: `${APP_FILE}#/circles`, mediaTypes: ['audio', 'video'] })).toBe(true);
    expect(request('media', { requestingUrl: APP_FILE, mediaTypes: ['audio'] })).toBe(true);
  });

  it('grants media to the dev server origin', () => {
    const { request } = install('http://localhost:5173/');
    expect(request('media', { requestingUrl: 'http://localhost:5173/#/x', mediaTypes: ['video'] })).toBe(true);
  });

  it('refuses media to other pages', () => {
    const { request } = install(APP_FILE);
    for (const requestingUrl of [
      'https://example.com/',
      'http://127.0.0.1:9119/board',
      'file:///tmp/other.html',
      'not a url',
    ]) {
      expect(request('media', { requestingUrl, mediaTypes: ['audio'] })).toBe(false);
    }
    const dev = install('http://localhost:5173/');
    expect(dev.request('media', { requestingUrl: 'http://localhost:5174/', mediaTypes: ['audio'] })).toBe(false);
  });

  it('refuses media to frames inside the app page', () => {
    const { request } = install(APP_FILE);
    expect(request('media', { requestingUrl: APP_FILE, mediaTypes: ['audio'], isMainFrame: false })).toBe(false);
  });

  it('refuses a media request with no audio or video in it', () => {
    const { request } = install(APP_FILE);
    expect(request('media', { requestingUrl: APP_FILE, mediaTypes: [] })).toBe(false);
    expect(request('media', { requestingUrl: APP_FILE })).toBe(false);
  });

  it('refuses other permissions, even to the app page', () => {
    const { request, check } = install(APP_FILE);
    for (const permission of ['geolocation', 'notifications', 'midi', 'openExternal', 'pointerLock', 'display-capture']) {
      expect(request(permission, { requestingUrl: APP_FILE })).toBe(false);
      expect(check(permission, { requestingUrl: APP_FILE })).toBe(false);
    }
  });

  it('keeps clipboard writes for the app page only', () => {
    const { request, check } = install(APP_FILE);
    expect(request('clipboard-sanitized-write', { requestingUrl: APP_FILE })).toBe(true);
    expect(request('clipboard-sanitized-write', { requestingUrl: 'https://example.com/' })).toBe(false);
    expect(check('clipboard-sanitized-write', { requestingUrl: APP_FILE })).toBe(true);
  });

  it('answers media checks for the app page only', () => {
    const { check } = install(APP_FILE);
    expect(check('media', { requestingUrl: APP_FILE, mediaType: 'audio' })).toBe(true);
    expect(check('media', { requestingUrl: 'https://example.com/', mediaType: 'audio' })).toBe(false);
    expect(check('media', { mediaType: 'audio' })).toBe(false);
    expect(check('media', { requestingUrl: APP_FILE, mediaType: 'audio', isMainFrame: false })).toBe(false);
  });
});

describe('media access', () => {
  beforeEach(() => {
    getStatus.mockReset();
    askForAccess.mockReset();
  });

  afterEach(() => {
    vi.mocked(ipcMain.handle).mockReset();
  });

  it('reports each device on macOS', () => {
    getStatus.mockImplementation((device) => (device === 'camera' ? 'denied' : 'granted'));
    expect(getMediaAccess('darwin')).toEqual({ camera: 'denied', microphone: 'granted' });
  });

  it('reports unknown on Linux without asking the OS', () => {
    expect(getMediaAccess('linux')).toEqual({ camera: 'unknown', microphone: 'unknown' });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('prompts on macOS when the user has not answered', async () => {
    getStatus.mockReturnValueOnce('not-determined').mockReturnValueOnce('granted');
    askForAccess.mockResolvedValue(true);
    await expect(requestMediaAccess('microphone', 'darwin')).resolves.toBe('granted');
    expect(askForAccess).toHaveBeenCalledWith('microphone');
  });

  it('reports a denial from the prompt', async () => {
    getStatus.mockReturnValueOnce('not-determined').mockReturnValueOnce('denied');
    askForAccess.mockResolvedValue(false);
    await expect(requestMediaAccess('camera', 'darwin')).resolves.toBe('denied');
  });

  it('does not prompt again once answered', async () => {
    getStatus.mockReturnValue('denied');
    await expect(requestMediaAccess('camera', 'darwin')).resolves.toBe('denied');
    expect(askForAccess).not.toHaveBeenCalled();
  });

  it('never prompts on Windows', async () => {
    getStatus.mockReturnValue('not-determined');
    await expect(requestMediaAccess('camera', 'win32')).resolves.toBe('not-determined');
    expect(askForAccess).not.toHaveBeenCalled();
  });

  it('refuses an unknown device over IPC', async () => {
    registerMediaHandlers();
    const handlers = new Map(vi.mocked(ipcMain.handle).mock.calls.map(([channel, fn]) => [channel, fn]));
    const requestAccess = handlers.get('media:request-access')!;
    expect(() => requestAccess({} as never, 'screen')).toThrow('Unknown media device.');
    expect(handlers.has('media:get-access')).toBe(true);
  });
});
