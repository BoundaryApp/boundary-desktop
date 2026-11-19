import { app, BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcast, getMainWindow, setMainWindowFactory, showMainWindow } from '../windows';
import { adoptDesktopAgentWindow, BUTTON_WINDOW, closeDesktopAgentWindows } from '../desktopAgent/desktopAgentWindows';

function fakeWindow(destroyed: boolean) {
  return { isDestroyed: () => destroyed, webContents: { isDestroyed: () => destroyed, send: vi.fn() } };
}

describe('broadcast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends to every live window and skips destroyed ones', () => {
    const live = fakeWindow(false);
    const gone = fakeWindow(true);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([live, gone] as never);
    broadcast('calendars:progress', { slug: 'work', step: 'saving' });
    expect(live.webContents.send).toHaveBeenCalledWith('calendars:progress', { slug: 'work', step: 'saving' });
    expect(gone.webContents.send).not.toHaveBeenCalled();
  });

  it('sends no argument when given no payload', () => {
    const live = fakeWindow(false);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([live] as never);
    broadcast('calendars:changed');
    expect(live.webContents.send).toHaveBeenCalledWith('calendars:changed');
  });

  it('skips the desktop button and panel windows, which have no page of their own', () => {
    const live = fakeWindow(false);
    const button = {
      ...fakeWindow(false),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      close: vi.fn(),
      setBounds: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 60, height: 60 }),
      on: vi.fn(),
    };
    adoptDesktopAgentWindow(button, BUTTON_WINDOW);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([live, button] as never);
    broadcast('calendars:changed');
    expect(live.webContents.send).toHaveBeenCalled();
    expect(button.webContents.send).not.toHaveBeenCalled();
    closeDesktopAgentWindows();
  });
});

describe('getMainWindow and showMainWindow', () => {
  beforeEach(() => {
    Object.assign(app, { isReady: () => true, focus: vi.fn() });
    global.mainWindow = undefined;
  });
  afterEach(() => {
    global.mainWindow = undefined;
    setMainWindowFactory(async () => undefined);
  });

  function mainWindow(destroyed = false) {
    return {
      isDestroyed: () => destroyed,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
  }

  it('returns the main window only while it is open, never another window', () => {
    const other = fakeWindow(false);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([other] as never);
    expect(getMainWindow()).toBeUndefined();
    global.mainWindow = mainWindow(true) as never;
    expect(getMainWindow()).toBeUndefined();
    const open = mainWindow();
    global.mainWindow = open as never;
    expect(getMainWindow()).toBe(open);
  });

  it('restores and focuses an open main window without re-creating it', async () => {
    const open = mainWindow();
    global.mainWindow = open as never;
    const factory = vi.fn(async () => undefined);
    setMainWindowFactory(factory);
    await expect(showMainWindow()).resolves.toBe(open);
    expect(open.restore).toHaveBeenCalled();
    expect(open.show).toHaveBeenCalled();
    expect(open.focus).toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('re-creates a closed main window through the registered factory', async () => {
    const created = mainWindow();
    setMainWindowFactory(async () => {
      global.mainWindow = created as never;
    });
    await expect(showMainWindow()).resolves.toBe(created);
  });

  it('does nothing before the app is ready', async () => {
    Object.assign(app, { isReady: () => false });
    const factory = vi.fn(async () => undefined);
    setMainWindowFactory(factory);
    await expect(showMainWindow()).resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });
});
