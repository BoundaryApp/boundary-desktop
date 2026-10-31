import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Store from 'electron-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_MENU_COMMAND_CHANNEL } from '../../shared/appCommands';

/**
 * Loads src/main/index.ts against a fake Electron and mocked services, and drives it through
 * the handlers it registers on app, process, ipcMain, the menu and the window.
 */

type Handler = (...args: any[]) => any;

const h = vi.hoisted(() => {
  const state = {
    appHandlers: {} as Record<string, Handler>,
    processHandlers: {} as Record<string, Handler>,
    ipcHandlers: {} as Record<string, Handler>,
    windows: [] as any[],
    menuTemplate: [] as any[],
    appReady: false,
  };

  class FakeEmitter {
    listeners: Record<string, Handler[]> = {};
    on(event: string, fn: Handler) {
      (this.listeners[event] ??= []).push(fn);
      return this;
    }
    once(event: string, fn: Handler) {
      const wrapped = (...args: any[]) => {
        this.listeners[event] = this.listeners[event].filter((f) => f !== wrapped);
        fn(...args);
      };
      return this.on(event, wrapped);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of [...(this.listeners[event] ?? [])]) fn(...args);
    }
  }

  class FakeWebContents extends FakeEmitter {
    send = vi.fn();
    windowOpenHandler: Handler | null = null;
    loading = true;
    setWindowOpenHandler(fn: Handler) {
      this.windowOpenHandler = fn;
    }
    isLoading() {
      return this.loading;
    }
    isDestroyed() {
      return false;
    }
    getURL() {
      return '';
    }
    session = { webRequest: { onHeadersReceived: vi.fn() } };
    openDevTools = vi.fn();
  }

  class FakeBrowserWindow extends FakeEmitter {
    static getAllWindows() {
      return state.windows.filter((w) => !w.destroyed);
    }
    options: any;
    destroyed = false;
    webContents = new FakeWebContents();
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(options: any) {
      super();
      this.options = options;
      state.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    getBounds() {
      return { x: 10, y: 10, width: 800, height: 600 };
    }
    getTitle() {
      return 'Boundary';
    }
    /** What Electron does when the user closes the window. */
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  }

  const display = { id: 42, workArea: { x: 0, y: 0, width: 2000, height: 1400 }, workAreaSize: { width: 2000, height: 1400 } };

  const electron = {
    app: {
      on: vi.fn((event: string, fn: Handler) => {
        state.appHandlers[event] = fn;
      }),
      quit: vi.fn(),
      exit: vi.fn(),
      focus: vi.fn(),
      isReady: () => state.appReady,
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
      setAsDefaultProtocolClient: vi.fn(),
      getPath: (name: string) => `/tmp/boundary-index-test/${name}`,
      getAppPath: () => '/tmp/boundary-index-test/app',
      getVersion: () => '0.0.0',
      getLocale: () => 'en',
      isPackaged: false,
      dock: { show: vi.fn(async () => undefined) },
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        state.ipcHandlers[channel] = fn;
      }),
    },
    Menu: Object.assign(function Menu() {}, {
      buildFromTemplate: vi.fn((template: any[]) => {
        state.menuTemplate = template;
        return template;
      }),
      setApplicationMenu: vi.fn(),
    }),
    MenuItem: function MenuItem() {},
    nativeTheme: { on: vi.fn(), shouldUseDarkColors: false, themeSource: 'system' },
    shell: { openExternal: vi.fn(async () => undefined) },
    screen: {
      getPrimaryDisplay: () => display,
      getAllDisplays: () => [display],
      getDisplayNearestPoint: () => display,
    },
  };

  const services = {
    persistDebugLog: vi.fn(),
    dockerDestroy: vi.fn(),
    stopHostBridge: vi.fn(async () => undefined),
    stopAssistantStack: vi.fn(async () => undefined),
  };

  return { state, electron, services };
});

vi.mock('electron', () => h.electron);
vi.mock('electron-squirrel-startup', () => ({ default: false }));
vi.mock('../perf/lagProbe', () => ({ startLagProbe: vi.fn() }));
vi.mock('../persistDebugLog', () => ({
  persistDebugLog: h.services.persistDebugLog,
  serializeError: (error: unknown) => ({ message: String(error) }),
  getDebugLogPath: () => '/tmp/boundary-index-test/boundary-debug.log',
  fileStatForLog: () => ({}),
}));
vi.mock('../services/dockerService', () => ({ dockerService: { destroy: h.services.dockerDestroy } }));
vi.mock('../services/onboarding/ipcHandlers', () => ({ registerOnboardingHandlers: vi.fn() }));
vi.mock('../services/updates/ipcHandlers', () => ({
  updateMenuItem: vi.fn(() => ({ label: 'Check for Updates…', click: vi.fn() })),
  quitAndInstallUpdate: vi.fn(),
  recordDataVersion: vi.fn(),
  registerUpdateHandlers: vi.fn(),
  startUpdates: vi.fn(async () => undefined),
}));
vi.mock('../services/capability/ipcHandlers', () => ({ registerCapabilityHandlers: vi.fn() }));
vi.mock('../services/setup/ipcHandlers', () => ({ registerSetupHandlers: vi.fn() }));
vi.mock('../services/assistant/ipcHandlers', () => ({ registerAssistantStackHandlers: vi.fn() }));
vi.mock('../services/resources/ipcHandlers', () => ({ registerResourceHandlers: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesChatIpc', () => ({ registerHermesChatHandlers: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesKanbanIpc', () => ({ registerKanbanHandlers: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesAgentsIpc', () => ({ registerAgentHandlers: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesChannelsIpc', () => ({ registerChannelHandlers: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesProjectsIpc', () => ({ registerProjectHandlers: vi.fn() }));
vi.mock('../services/assistant/coding/codingIpc', () => ({ registerCodingFolderHandlers: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesBoard', () => ({ installBoardWebviewGuards: vi.fn() }));
vi.mock('../services/assistant/hermes/hermesVaultIpc', () => ({ registerHermesVaultHandlers: vi.fn() }));
vi.mock('../services/assistant/calendar/calendarIpc', () => ({ registerCalendarHandlers: vi.fn() }));
vi.mock('../services/assistant/calendar/calendarService', () => ({ startCalendarHealthChecks: vi.fn() }));
vi.mock('../services/hostBridge/ipcHandlers', () => ({ registerHostBridgeHandlers: vi.fn() }));
vi.mock('../services/hostBridge/hostBridgeService', () => ({
  ensureHostBridgeStarted: vi.fn(async () => undefined),
  stopHostBridge: h.services.stopHostBridge,
}));
vi.mock('../services/assistant/AssistantStackService', () => ({
  announceAssistantStackStopping: vi.fn(),
  ensureAssistantStackOnLaunch: vi.fn(async () => undefined),
  stopAssistantStack: h.services.stopAssistantStack,
}));
vi.mock('../services/onboarding/LocalLlmWatcher', () => ({ startLocalLlmWatcher: vi.fn() }));
vi.mock('../experiments', () => ({
  registerExperiments: vi.fn(),
  startExperimentsBeforeWindow: vi.fn(async () => undefined),
}));
vi.mock('../singleInstance', () => ({ claimSingleInstance: () => true }));
vi.mock('../migrations', () => ({ runStartupMigrations: vi.fn() }));

const realPlatform = process.platform;
let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

/** Import a fresh copy of main on `platform`, with process listeners captured instead of installed. */
async function loadMain(platform: NodeJS.Platform = 'darwin'): Promise<void> {
  vi.resetModules();
  h.state.appHandlers = {};
  h.state.processHandlers = {};
  h.state.ipcHandlers = {};
  h.state.windows = [];
  h.state.menuTemplate = [];
  h.state.appReady = false;
  global.mainWindow = undefined;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: Handler) => {
    h.state.processHandlers[event] = fn;
    return process;
  }) as typeof process.on);
  try {
    await import('../index');
  } finally {
    onSpy.mockRestore();
  }
}

/**
 * Run app `ready` and return the window it created. The listener doesn't return its promise,
 * so this waits for the log line written once the window is up.
 */
async function ready(): Promise<any> {
  h.state.appReady = true;
  const windowUp = new Promise<void>((resolve) => {
    h.services.persistDebugLog.mockImplementation((_area: string, message: string) => {
      if (message === 'createWindow returned') resolve();
    });
  });
  h.state.appHandlers.ready();
  await windowUp;
  h.services.persistDebugLog.mockImplementation(() => undefined);
  return h.state.windows.at(-1);
}

function menuItem(label: string): any {
  for (const top of h.state.menuTemplate) {
    const found = (top.submenu ?? []).find((item: any) => item.label === label);
    if (found) return found;
  }
  throw new Error(`no menu item ${label}`);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  exitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('main window logging (G02-3)', () => {
  it('passes main\'s DEBUG value to the window\'s preload', async () => {
    vi.stubEnv('DEBUG', 'boundary:*');
    await loadMain();
    const win = await ready();
    expect(win.options.webPreferences.additionalArguments).toContain('--boundary-debug=boundary:*');
  });
});

describe('urls:open-url (G13-19)', () => {
  it('is registered outside development and opens http(s) URLs', async () => {
    await loadMain();
    const handler = h.state.ipcHandlers['urls:open-url'];
    expect(handler).toBeTypeOf('function');
    await expect(handler({}, 'http://localhost:8080/')).resolves.toEqual({ success: true });
    await expect(handler({}, 'https://example.com/a')).resolves.toEqual({ success: true });
    expect(h.electron.shell.openExternal).toHaveBeenCalledTimes(2);
  });

  it('refuses other schemes and non-URLs', async () => {
    await loadMain();
    const handler = h.state.ipcHandlers['urls:open-url'];
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url', 42]) {
      const result = await handler({}, url);
      expect(result.success).toBe(false);
    }
    expect(h.electron.shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('restart to install', () => {
  const closeEvent = (win: any) => {
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    return event;
  };

  async function restart() {
    vi.useFakeTimers();
    await loadMain();
    const win = await readyWithFakeTimers();
    const updates = await import('../services/updates/ipcHandlers');
    const installAndRestart = vi.mocked(updates.registerUpdateHandlers).mock.calls[0][0];
    installAndRestart();
    return { win, quitAndInstall: vi.mocked(updates.quitAndInstallUpdate) };
  }

  async function readyWithFakeTimers() {
    const windowUp = ready();
    await vi.advanceTimersByTimeAsync(0);
    return windowUp;
  }

  it('keeps the window open while the stack stops, then lets it close for Squirrel', async () => {
    const { win, quitAndInstall } = await restart();
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.services.stopAssistantStack).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).toHaveBeenCalledOnce();
    expect(closeEvent(win).preventDefault).not.toHaveBeenCalled();
  });

  it('leaves the quit to Squirrel once the windows have closed', async () => {
    await restart();
    await vi.advanceTimersByTimeAsync(150);
    h.state.appHandlers['window-all-closed']();
    expect(h.electron.app.quit).not.toHaveBeenCalled();
  });

  it('exits if Squirrel never takes over', async () => {
    await restart();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.electron.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.electron.app.exit).toHaveBeenCalledWith(0);
  });

  it('still keeps the window for a plain quit', async () => {
    vi.useFakeTimers();
    await loadMain();
    const win = await readyWithFakeTimers();
    h.state.appHandlers['before-quit']({ preventDefault: vi.fn() });
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
  });
});

describe('menu commands after the window closes (G15-10)', () => {
  it('clears global.mainWindow when the window closes', async () => {
    await loadMain();
    const win = await ready();
    expect(global.mainWindow).toBe(win);
    win.close();
    expect(global.mainWindow).toBeUndefined();
  });

  it('reopens the window and sends the command once it has loaded', async () => {
    await loadMain();
    const first = await ready();
    first.close();

    menuItem('Settings…').click();
    await vi.waitFor(() => expect(h.state.windows).toHaveLength(2));
    const second = h.state.windows[1];
    // createWindow adds one did-finish-load listener; the menu command adds the second.
    await vi.waitFor(() => expect(second.webContents.listeners['did-finish-load']).toHaveLength(2));

    expect(global.mainWindow).toBe(second);
    expect(second.webContents.send).not.toHaveBeenCalled();
    second.webContents.loading = false;
    second.webContents.emit('did-finish-load');
    expect(second.webContents.send).toHaveBeenCalledWith(APP_MENU_COMMAND_CHANNEL, 'go-settings');
    expect(first.webContents.send).not.toHaveBeenCalled();
  });

  it('sends straight to an open window', async () => {
    await loadMain();
    const win = await ready();
    menuItem('New Chat').click();
    expect(win.webContents.send).toHaveBeenCalledWith(APP_MENU_COMMAND_CHANNEL, 'new-chat');
  });
});

describe('app ready', () => {
  it('logs a throw before the window step instead of leaving the rejection unhandled', async () => {
    await loadMain();
    h.electron.Menu.buildFromTemplate.mockImplementationOnce(() => {
      throw new Error('menu');
    });
    h.state.appReady = true;
    h.state.appHandlers.ready();
    await flush();
    expect(h.services.persistDebugLog).toHaveBeenCalledWith('startup', 'ready handler threw', expect.anything());
    expect(h.state.windows).toHaveLength(0);
  });
});

describe('process error handlers (G15-11)', () => {
  it('logs an unhandled rejection and keeps running', async () => {
    await loadMain();
    h.state.processHandlers.unhandledRejection(new Error('stray promise'));
    await flush();
    expect(h.services.persistDebugLog).toHaveBeenCalledWith('startup', 'unhandledRejection', expect.anything());
    expect(exitSpy).not.toHaveBeenCalled();
    expect(h.services.stopHostBridge).not.toHaveBeenCalled();
    expect(h.services.stopAssistantStack).not.toHaveBeenCalled();
  });

  it('runs the quit teardown on an uncaught exception, then exits', async () => {
    await loadMain();
    h.state.processHandlers.uncaughtException(new Error('boom'));
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    expect(h.services.persistDebugLog).toHaveBeenCalledWith('startup', 'uncaughtException', expect.anything());
    expect(h.services.stopHostBridge).toHaveBeenCalledTimes(1);
    expect(h.services.stopAssistantStack).toHaveBeenCalledTimes(1);
    expect(h.services.dockerDestroy).toHaveBeenCalled();
  });

  it('exits at the deadline when teardown hangs', async () => {
    vi.useFakeTimers();
    await loadMain();
    h.services.stopAssistantStack.mockImplementationOnce(() => new Promise(() => undefined));
    h.state.processHandlers.uncaughtException(new Error('boom'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(h.services.dockerDestroy).toHaveBeenCalled();
  });
});

describe('macOS window move (G15-12)', () => {
  it('saves the display the window moved to', async () => {
    await loadMain('darwin');
    const win = await ready();
    const store = new Store<Record<string, unknown>>({ name: 'boundary-config' });
    store.delete('lastDisplayId');
    expect(() => win.emit('move')).not.toThrow();
    expect(store.get('lastDisplayId')).toBe(42);
  });
});

describe('platform setup (G15-14)', () => {
  it('sets the Windows app user model id on win32 only', async () => {
    await loadMain('win32');
    expect(h.electron.app.setAppUserModelId).toHaveBeenCalledWith('com.boundary.desktop');
    vi.clearAllMocks();
    await loadMain('darwin');
    expect(h.electron.app.setAppUserModelId).not.toHaveBeenCalled();
  });

  it('sets the app name once', async () => {
    await loadMain('darwin');
    await ready();
    expect(h.electron.app.setName).toHaveBeenCalledTimes(1);
    expect(h.electron.app.setName).toHaveBeenCalledWith('Boundary');
  });
});

describe('main window navigation (G15-16)', () => {
  it('denies window.open and sends http(s) links to the system browser', async () => {
    await loadMain();
    const win = await ready();
    const handler = win.webContents.windowOpenHandler;
    expect(handler).toBeTypeOf('function');
    expect(handler({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(h.electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(h.electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('blocks navigation away from the app and opens http(s) targets outside', async () => {
    await loadMain();
    const win = await ready();
    const navigate = (url: string) => {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit('will-navigate', event, url);
      return event.preventDefault;
    };

    const appUrl = pathToFileURL(win.loadFile.mock.calls[0][0]).href;
    expect(navigate(`${appUrl}#/settings`)).not.toHaveBeenCalled();

    expect(navigate('https://example.com/')).toHaveBeenCalled();
    expect(navigate('file:///etc/passwd')).toHaveBeenCalled();
    expect(navigate(pathToFileURL(path.join(path.dirname(win.loadFile.mock.calls[0][0]), 'other.html')).href)).toHaveBeenCalled();
    expect(h.electron.shell.openExternal).toHaveBeenCalledTimes(1);
    expect(h.electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('allows navigation within the dev server origin', async () => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
    await loadMain();
    const win = await ready();
    const event = { preventDefault: vi.fn() };
    win.webContents.emit('will-navigate', event, 'http://localhost:5173/index.html');
    expect(event.preventDefault).not.toHaveBeenCalled();
    const away = { preventDefault: vi.fn() };
    win.webContents.emit('will-navigate', away, 'http://localhost:9119/');
    expect(away.preventDefault).toHaveBeenCalled();
  });
});
