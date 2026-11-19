import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebContents } from './fakeWindow';

const h = vi.hoisted(() => ({
  template: [] as any[],
  mainWindow: undefined as undefined | { webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean } },
  showMainWindow: vi.fn(),
  setButtonHidden: vi.fn(),
}));

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: any[]) => {
      h.template = template;
      return template;
    }),
    setApplicationMenu: vi.fn(),
  },
}));
vi.mock('../persistDebugLog', () => ({ persistDebugLog: vi.fn(), serializeError: () => ({}) }));
vi.mock('../services/windows', () => ({
  getMainWindow: () => h.mainWindow,
  showMainWindow: h.showMainWindow,
}));
vi.mock('../services/updates/ipcHandlers', () => ({
  updateMenuItem: () => ({ label: 'Check for Updates…', click: vi.fn() }),
}));
vi.mock('../services/desktopAgent/desktopAgentWindows', () => ({ setButtonHidden: h.setButtonHidden }));

const electron = await import('electron');
const { createAppMenu } = await import('../appMenu');

const realPlatform = process.platform;

function menuItem(label: string): any {
  for (const top of h.template) {
    const found = (top.submenu ?? []).find((item: any) => item.label === label);
    if (found) return found;
  }
  throw new Error(`no menu item ${label}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mainWindow = undefined;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('createAppMenu', () => {
  it('sets the menu with the app, File, Edit, View, Go, Window and Help menus', () => {
    createAppMenu();
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledWith(h.template);
    expect(h.template.map((top) => top.label ?? top.role)).toEqual([
      'Boundary',
      'File',
      'Edit',
      'View',
      'Go',
      'Window',
      'help',
    ]);
    expect(menuItem('Check for Updates…')).toBeDefined();
  });

  it('shows command shortcuts but leaves the key press to the renderer', () => {
    createAppMenu();
    expect(menuItem('New Chat')).toMatchObject({ registerAccelerator: false });
    expect(menuItem('New Chat').accelerator).toBeTruthy();
  });

  it('sends a command straight to an open window', () => {
    h.mainWindow = { webContents: { send: vi.fn(), isDestroyed: () => false } };
    createAppMenu();
    menuItem('New Chat').click();
    expect(h.mainWindow.webContents.send).toHaveBeenCalledWith('app:menu-command', 'new-chat');
    expect(h.showMainWindow).not.toHaveBeenCalled();
  });

  it('reopens a closed window and sends the command once it has loaded (G15-10)', async () => {
    const reopened = { webContents: new FakeWebContents() };
    h.showMainWindow.mockResolvedValueOnce(reopened);
    createAppMenu();
    menuItem('Settings…').click();
    await vi.waitFor(() => expect(reopened.webContents.listeners['did-finish-load']).toHaveLength(1));
    expect(reopened.webContents.send).not.toHaveBeenCalled();
    reopened.webContents.emit('did-finish-load');
    expect(reopened.webContents.send).toHaveBeenCalledWith('app:menu-command', 'go-settings');
  });

  it('Window → Show Agent Button brings a hidden button back (macOS only)', () => {
    createAppMenu();
    menuItem('Show Agent Button').click();
    expect(h.setButtonHidden).toHaveBeenCalledWith(false);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    createAppMenu();
    expect(() => menuItem('Show Agent Button')).toThrow();
  });
});
