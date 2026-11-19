import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigStore, DEFAULT_WINDOW_BOUNDS } from '../configStore';
import { createMainWindowFactory, restoredBounds, saveDisplayForQuit } from '../mainWindow';
import { FakeBrowserWindow, fakeChildWindow, fakeDisplay } from './fakeWindow';

const h = vi.hoisted(() => ({
  displays: [] as { id: number; workArea: { x: number; y: number; width: number; height: number } }[],
  desktopAgentOn: false,
  quitting: false,
  installingUpdate: false,
}));

vi.mock('electron', async () => {
  const { FakeBrowserWindow, fakeDisplay } = await import('./fakeWindow');
  return {
    app: { focus: vi.fn(), isPackaged: false },
    BrowserWindow: FakeBrowserWindow,
    nativeTheme: { on: vi.fn(), shouldUseDarkColors: false, themeSource: 'system' },
    shell: { openExternal: vi.fn(async () => undefined) },
    // The development context menu.
    Menu: class {
      items: { label: string }[] = [];
      append(item: { label: string }) {
        this.items.push(item);
      }
      popup = vi.fn();
    },
    MenuItem: class {
      constructor(options: { label: string }) {
        Object.assign(this, options);
      }
    },
    screen: {
      getPrimaryDisplay: () => fakeDisplay,
      getAllDisplays: () => h.displays,
      getDisplayNearestPoint: (point: { x: number }) =>
        h.displays.find((d) => point.x >= d.workArea.x && point.x < d.workArea.x + d.workArea.width) ?? fakeDisplay,
    },
  };
});
vi.mock('../persistDebugLog', () => ({
  persistDebugLog: vi.fn(),
  serializeError: (error: unknown) => ({ message: String(error) }),
  fileStatForLog: () => ({}),
}));
vi.mock('../quit', () => ({
  isQuitting: () => h.quitting,
  isInstallingUpdate: () => h.installingUpdate,
}));
vi.mock('../services/desktopAgent/ipcHandlers', () => ({ desktopAgentOn: () => h.desktopAgentOn }));
vi.mock('../services/desktopAgent/desktopAgentWindows', () => ({
  adoptDesktopAgentWindow: vi.fn(),
  closeDesktopAgentWindows: vi.fn(),
  desktopAgentOpenResponse: vi.fn((frameName: string) =>
    h.desktopAgentOn && frameName === 'boundary-agent-button' ? { action: 'allow' } : null
  ),
}));

const electron = await import('electron');
const desktopWindows = await import('../services/desktopAgent/desktopAgentWindows');

const store = createConfigStore();
const smokeDeps = { exit: vi.fn(), log: vi.fn() };
const realPlatform = process.platform;

async function openWindow(options: { isDevelopment?: boolean } = {}): Promise<FakeBrowserWindow> {
  await createMainWindowFactory({ store, isDevelopment: options.isDevelopment ?? false, smokeDeps })();
  return FakeBrowserWindow.made.at(-1)!;
}

function closeEvent(win: FakeBrowserWindow) {
  const event = { preventDefault: vi.fn() };
  win.emit('close', event);
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeBrowserWindow.reset();
  store.clear();
  global.mainWindow = undefined;
  h.displays = [fakeDisplay];
  h.desktopAgentOn = false;
  h.quitting = false;
  h.installingUpdate = false;
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

const primary = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const secondary = { id: 2, workArea: { x: 1440, y: 0, width: 2560, height: 1415 } };

describe('restoredBounds', () => {
  it('centres the default size on the primary display on first launch', () => {
    expect(restoredBounds({ width: 800, height: 600 }, undefined, [primary], primary)).toEqual({
      x: 320,
      y: 162,
      width: 800,
      height: 600,
    });
  });

  it('keeps saved bounds that sit inside the display', () => {
    const saved = { x: 100, y: 100, width: 800, height: 600 };
    expect(restoredBounds(saved, 1, [primary], primary)).toEqual(saved);
  });

  // Before the split the check used the primary display's size, so this window was re-centred.
  it('keeps a window saved on a secondary display there', () => {
    const saved = { x: 1600, y: 100, width: 1200, height: 900 };
    expect(restoredBounds(saved, 2, [primary, secondary], primary)).toEqual(saved);
  });

  it('centres on the saved display when the saved position is off it', () => {
    expect(restoredBounds({ x: 10, y: 10, width: 1000, height: 600 }, 2, [primary, secondary], primary)).toEqual({
      x: 2220,
      y: 407,
      width: 1000,
      height: 600,
    });
  });

  it('falls back to the primary display when the saved one is gone', () => {
    expect(restoredBounds({ x: 1600, y: 100, width: 800, height: 600 }, 2, [primary], primary)).toEqual({
      x: 320,
      y: 162,
      width: 800,
      height: 600,
    });
  });
});

describe('opening the main window', () => {
  it('uses the default size on first launch', async () => {
    const win = await openWindow();
    expect(win.options).toMatchObject({ width: DEFAULT_WINDOW_BOUNDS.width, height: DEFAULT_WINDOW_BOUNDS.height });
    expect(global.mainWindow).toBe(win);
  });

  it('reopens on the saved secondary display', async () => {
    h.displays = [fakeDisplay, { id: 7, workArea: { x: 2000, y: 0, width: 2560, height: 1440 } }];
    store.set('windowBounds', { x: 2100, y: 50, width: 1200, height: 900 });
    store.set('lastDisplayId', 7);
    const win = await openWindow();
    expect(win.options).toMatchObject({ x: 2100, y: 50, width: 1200, height: 900 });
  });

  it("passes main's DEBUG value to the window's preload", async () => {
    vi.stubEnv('DEBUG', 'boundary:*');
    const win = await openWindow();
    expect(win.options.webPreferences.additionalArguments).toContain('--boundary-debug=boundary:*');
  });

  it('clears global.mainWindow when the window closes', async () => {
    const win = await openWindow();
    win.close();
    expect(global.mainWindow).toBeUndefined();
  });

  it('allows the dev stack in the CSP only in development', async () => {
    const csp = async (isDevelopment: boolean) => {
      const win = await openWindow({ isDevelopment });
      const onHeaders = win.webContents.session.webRequest.onHeadersReceived.mock.calls[0][0];
      const callback = vi.fn();
      onHeaders({ responseHeaders: {} }, callback);
      return callback.mock.calls[0][0].responseHeaders['Content-Security-Policy'][0] as string;
    };
    expect(await csp(false)).toContain('https://localhost:*; font-src');
    expect(await csp(true)).toContain('https://localhost:* http://127.0.0.1:*; font-src');
  });

  it('adds the inspect context menu only in development', async () => {
    expect((await openWindow()).webContents.listeners['context-menu']).toBeUndefined();
    expect((await openWindow({ isDevelopment: true })).webContents.listeners['context-menu']).toHaveLength(1);
  });
});

describe('saving the window position', () => {
  it('saves bounds and display on move, with one move listener (macOS)', async () => {
    h.displays = [fakeDisplay, { id: 7, workArea: { x: 2000, y: 0, width: 2560, height: 1440 } }];
    const win = await openWindow();
    expect(win.listeners.move).toHaveLength(1);
    win.bounds = { x: 2100, y: 40, width: 900, height: 700 };
    win.emit('move');
    expect(store.get('windowBounds')).toEqual({ x: 2100, y: 40, width: 900, height: 700 });
    expect(store.get('lastDisplayId')).toBe(7);
  });

  it('saves bounds but no display on move elsewhere', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const win = await openWindow();
    win.emit('move');
    expect(store.get('windowBounds')).toEqual(win.bounds);
    expect(store.get('lastDisplayId')).toBeUndefined();
  });

  it('saves bounds on resize', async () => {
    const win = await openWindow();
    win.bounds = { x: 0, y: 0, width: 1000, height: 800 };
    win.emit('resize');
    expect(store.get('windowBounds')).toEqual(win.bounds);
  });

  it('saves the display at quit on macOS', async () => {
    h.displays = [fakeDisplay, { id: 7, workArea: { x: 2000, y: 0, width: 2560, height: 1440 } }];
    const win = await openWindow();
    win.bounds = { x: 2500, y: 0, width: 900, height: 700 };
    await saveDisplayForQuit(store);
    expect(store.get('lastDisplayId')).toBe(7);
  });
});

describe('main window navigation (G15-16)', () => {
  it('denies window.open and sends http(s) links to the system browser', async () => {
    const win = await openWindow();
    const handler = win.webContents.windowOpenHandler!;
    expect(handler({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('blocks navigation away from the app and opens http(s) targets outside', async () => {
    const win = await openWindow();
    const navigate = (url: string) => {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit('will-navigate', event, url);
      return event.preventDefault;
    };
    const indexPath = win.loadFile.mock.calls[0][0] as string;
    expect(navigate(`${pathToFileURL(indexPath).href}#/settings`)).not.toHaveBeenCalled();
    expect(navigate('https://example.com/')).toHaveBeenCalled();
    expect(navigate('file:///etc/passwd')).toHaveBeenCalled();
    expect(navigate(pathToFileURL(path.join(path.dirname(indexPath), 'other.html')).href)).toHaveBeenCalled();
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('allows navigation within the dev server origin', async () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
    const win = await openWindow();
    const inside = { preventDefault: vi.fn() };
    win.webContents.emit('will-navigate', inside, 'http://localhost:5173/index.html');
    expect(inside.preventDefault).not.toHaveBeenCalled();
    const away = { preventDefault: vi.fn() };
    win.webContents.emit('will-navigate', away, 'http://localhost:9119/');
    expect(away.preventDefault).toHaveBeenCalled();
  });
});

describe('closing the window', () => {
  it('closes when the desktop button is off', async () => {
    const win = await openWindow();
    expect(closeEvent(win).preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('hides instead of closing while the desktop button is on, and tells the page (ADR 0058 §1)', async () => {
    h.desktopAgentOn = true;
    const win = await openWindow();
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('app-window:shown', false);
    win.show();
    expect(win.webContents.send).toHaveBeenCalledWith('app-window:shown', true);
  });

  // Review: hiding a full-screen window on macOS leaves its Space black.
  it('leaves full screen first and hides once it has', async () => {
    h.desktopAgentOn = true;
    const win = await openWindow();
    win.fullScreen = true;
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
    expect(win.setFullScreen).toHaveBeenCalledWith(false);
    expect(win.hide).not.toHaveBeenCalled();
    win.emit('leave-full-screen');
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it('runs with background throttling off only while the desktop button is on', async () => {
    expect((await openWindow()).options.webPreferences.backgroundThrottling).toBe(true);
    h.desktopAgentOn = true;
    expect((await openWindow()).options.webPreferences.backgroundThrottling).toBe(false);
  });

  it('stays open while quitting, so the quit screen shows', async () => {
    h.desktopAgentOn = true;
    const win = await openWindow();
    h.quitting = true;
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('closes while an update installs', async () => {
    const win = await openWindow();
    h.quitting = true;
    h.installingUpdate = true;
    expect(closeEvent(win).preventDefault).not.toHaveBeenCalled();
  });
});

describe('the desktop windows (ADR 0058)', () => {
  it('lets the page open them only when desktopAgentWindows allows it', async () => {
    h.desktopAgentOn = true;
    const win = await openWindow();
    const handler = win.webContents.windowOpenHandler!;
    expect(handler({ url: 'about:blank', frameName: 'boundary-agent-button' })).toEqual({ action: 'allow' });
    expect(handler({ url: 'about:blank', frameName: 'other' })).toEqual({ action: 'deny' });
    expect(electron.shell.openExternal).not.toHaveBeenCalled();
  });

  // Review: the children carry the preload, so nothing may open or load elsewhere in them.
  it('sends links from a desktop window to the browser and keeps it on its page', async () => {
    const win = await openWindow();
    const child = fakeChildWindow();
    win.webContents.emit('did-create-window', child, { frameName: 'boundary-agent-panel', url: 'about:blank' });
    expect(desktopWindows.adoptDesktopAgentWindow).toHaveBeenCalledWith(child, 'boundary-agent-panel');
    expect(child.webContents.openHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    const navigation = { preventDefault: vi.fn() };
    child.webContents.listeners['will-navigate'](navigation, 'https://example.com/other');
    expect(navigation.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(electron.shell.openExternal).toHaveBeenCalledTimes(2));
  });

  it('closes them when the page navigates or reloads', async () => {
    const win = await openWindow();
    win.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(desktopWindows.closeDesktopAgentWindows).not.toHaveBeenCalled();
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(desktopWindows.closeDesktopAgentWindows).toHaveBeenCalled();
  });
});
