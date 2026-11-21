import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Store from 'electron-store';
import type { FakeBrowserWindow } from './fakeWindow';

/**
 * The boot sequence: src/main/index.ts loaded against a fake Electron and mocked services, then
 * driven through the handlers it registers. Each module's own behaviour is tested beside it
 * (quit.test.ts, mainWindow.test.ts, appMenu.test.ts); this file keeps how they are wired up,
 * and the quit and reopen paths that cross them.
 */

type Handler = (...args: any[]) => any;

// Loaded once, so every fresh copy of main (loadMain resets modules) makes the same fake windows.
const fake = await vi.hoisted(() => import('./fakeWindow'));
const Win = fake.FakeBrowserWindow;

const h = vi.hoisted(() => {
  const state = {
    appHandlers: {} as Record<string, Handler>,
    processHandlers: {} as Record<string, Handler>,
    ipcHandlers: {} as Record<string, Handler>,
    menuTemplate: [] as any[],
    appReady: false,
    squirrel: false,
  };

  const electron = {
    app: {
      on: vi.fn((event: string, fn: Handler) => {
        state.appHandlers[event] = fn;
      }),
      quit: vi.fn(),
      exit: vi.fn(),
      focus: vi.fn(),
      isReady: () => state.appReady,
      // Never settles: the panel shortcut waits on it, and these tests set none.
      whenReady: () => new Promise<void>(() => undefined),
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
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        state.ipcHandlers[channel] = fn;
      }),
    },
    Menu: Object.assign(function Menu() {}, {
      buildFromTemplate: vi.fn((template: any[]) => {
        state.menuTemplate = template;
        return Object.assign([...template], { popup: vi.fn() });
      }),
      setApplicationMenu: vi.fn(),
    }),
    MenuItem: function MenuItem() {},
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    nativeTheme: { on: vi.fn(), shouldUseDarkColors: false, themeSource: 'system' },
    shell: { openExternal: vi.fn(async () => undefined) },
    dialog: { showMessageBox: vi.fn() },
  };

  const services = {
    persistDebugLog: vi.fn(),
    dockerDestroy: vi.fn(),
    stopHostBridge: vi.fn(async () => undefined),
    stopAssistantStack: vi.fn(async () => undefined),
    stopExperiments: vi.fn(async () => undefined),
    stopBundledMachineIfStarted: vi.fn(async () => false),
    closeDesktopAgentWindows: vi.fn(),
  };

  return { state, electron, services };
});

vi.mock('electron', () => ({
  ...h.electron,
  BrowserWindow: fake.FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => fake.fakeDisplay,
    getAllDisplays: () => [fake.fakeDisplay],
    getDisplayNearestPoint: () => fake.fakeDisplay,
  },
}));

vi.mock('electron-squirrel-startup', () => ({
  get default() {
    return h.state.squirrel;
  },
}));
vi.mock('../perf/lagProbe', () => ({ startLagProbe: vi.fn() }));
vi.mock('../persistDebugLog', () => ({
  persistDebugLog: h.services.persistDebugLog,
  serializeError: (error: unknown) => ({ message: String(error) }),
  getDebugLogPath: () => '/tmp/boundary-index-test/boundary-debug.log',
  fileStatForLog: () => ({}),
}));
vi.mock('../services/dockerService', () => ({ dockerService: { destroy: h.services.dockerDestroy } }));
vi.mock('../services/containerRuntime', () => ({
  stopBundledMachineIfStarted: h.services.stopBundledMachineIfStarted,
}));
vi.mock('../services/onboarding/ipcHandlers', () => ({ registerOnboardingHandlers: vi.fn() }));
vi.mock('../services/updates/ipcHandlers', () => ({
  updateMenuItem: vi.fn(() => ({ label: 'Check for Updates…', click: vi.fn() })),
  quitAndInstallUpdate: vi.fn(),
  recordDataVersion: vi.fn(),
  registerUpdateHandlers: vi.fn(),
  startUpdates: vi.fn(async () => undefined),
  closeUpdatedCard: vi.fn(),
}));
vi.mock('../services/whatsNew/ipcHandlers', () => ({ registerWhatsNewHandlers: vi.fn() }));
vi.mock('../services/capability/ipcHandlers', () => ({ registerCapabilityHandlers: vi.fn() }));
vi.mock('../services/setup/ipcHandlers', () => ({ registerSetupHandlers: vi.fn() }));
vi.mock('../services/assistant/ipcHandlers', () => ({ registerAssistantStackHandlers: vi.fn() }));
vi.mock('../services/resources/ipcHandlers', () => ({ registerResourceHandlers: vi.fn() }));
vi.mock('../services/addons/ipcHandlers', () => ({ registerAddonHandlers: vi.fn() }));
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
  currentCredentialClientTokens: vi.fn(async () => []),
  setCredentialClientFolder: vi.fn(),
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
  stopExperiments: h.services.stopExperiments,
}));
vi.mock('../singleInstance', () => ({ claimSingleInstance: () => true }));
vi.mock('../services/desktopAgent/desktopAgentWindows', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/desktopAgent/desktopAgentWindows')>();
  return {
    ...real,
    closeDesktopAgentWindows: vi.fn(() => {
      h.services.closeDesktopAgentWindows();
      real.closeDesktopAgentWindows();
    }),
    // Quit and update close them for good; refusing them after is desktopAgentWindows' own test.
    closeDesktopAgentWindowsForGood: vi.fn(() => {
      h.services.closeDesktopAgentWindows();
      real.closeDesktopAgentWindows();
    }),
  };
});
vi.mock('../migrations', () => ({ runStartupMigrations: vi.fn() }));

const realPlatform = process.platform;
let exitSpy: ReturnType<typeof vi.spyOn>;

/** Import a fresh copy of main on `platform`, with process listeners captured instead of installed. */
async function loadMain(platform: NodeJS.Platform = 'darwin'): Promise<void> {
  vi.resetModules();
  h.state.appHandlers = {};
  h.state.processHandlers = {};
  h.state.ipcHandlers = {};
  h.state.menuTemplate = [];
  h.state.appReady = false;
  Win.reset();
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
async function ready(): Promise<FakeBrowserWindow> {
  h.state.appReady = true;
  const windowUp = new Promise<void>((resolve) => {
    h.services.persistDebugLog.mockImplementation((_area: string, message: string) => {
      if (message === 'createWindow returned') resolve();
    });
  });
  h.state.appHandlers.ready();
  await windowUp;
  h.services.persistDebugLog.mockImplementation(() => undefined);
  return Win.made.at(-1)!;
}

/** `ready` under fake timers, which hold the promise it waits on until they advance. */
async function readyWithFakeTimers(): Promise<FakeBrowserWindow> {
  const windowUp = ready();
  await vi.advanceTimersByTimeAsync(0);
  return windowUp;
}

function menuItem(label: string): any {
  for (const top of h.state.menuTemplate) {
    const found = (top.submenu ?? []).find((item: any) => item.label === label);
    if (found) return found;
  }
  throw new Error(`no menu item ${label}`);
}

function closeEvent(win: FakeBrowserWindow) {
  const event = { preventDefault: vi.fn() };
  win.emit('close', event);
  return event;
}

const config = () => new Store<Record<string, unknown>>({ name: 'boundary-config' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// The first import of main loads its whole module graph: about a second alone, and past the 5s
// test timeout during a busy full run. Each test's fresh copy after that takes milliseconds, so
// the cold load happens here, under the hook's own timeout.
beforeAll(async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(((): void => undefined) as never);
  try {
    await loadMain();
  } finally {
    exit.mockRestore();
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  h.state.squirrel = false;
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): void => undefined) as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  exitSpy.mockRestore();
  vi.useRealTimers();
  config().delete('desktopAgentButton');
});

describe('boot', () => {
  it('registers the IPC handlers and the app lifecycle', async () => {
    await loadMain();
    expect(h.state.ipcHandlers['urls:open-url']).toBeTypeOf('function');
    expect(h.state.ipcHandlers['desktop-agent:set']).toBeTypeOf('function');
    expect(Object.keys(h.state.appHandlers)).toEqual(
      expect.arrayContaining(['ready', 'activate', 'before-quit', 'window-all-closed', 'quit'])
    );
    expect(h.state.processHandlers.uncaughtException).toBeTypeOf('function');
  });

  it('sets the menu, then opens the window, on ready', async () => {
    await loadMain();
    const win = await ready();
    expect(h.electron.Menu.setApplicationMenu).toHaveBeenCalledOnce();
    expect(global.mainWindow).toBe(win);
  });

  it('logs a throw before the window step instead of leaving the rejection unhandled', async () => {
    await loadMain();
    h.electron.Menu.buildFromTemplate.mockImplementationOnce(() => {
      throw new Error('menu');
    });
    h.state.appReady = true;
    h.state.appHandlers.ready();
    await flush();
    expect(h.services.persistDebugLog).toHaveBeenCalledWith('startup', 'ready handler threw', expect.anything());
    expect(Win.made).toHaveLength(0);
  });

  // Before, `app.quit()` did not stop the code below it, so an install or uninstall run went on
  // to claim the lock, register handlers and could open a window.
  it('quits a Squirrel install or uninstall run before anything else starts', async () => {
    h.state.squirrel = true;
    await loadMain('win32');
    expect(h.electron.app.quit).toHaveBeenCalledOnce();
    expect(h.electron.app.on).not.toHaveBeenCalled();
    expect(h.electron.ipcMain.handle).not.toHaveBeenCalled();
    expect(h.electron.app.setAppUserModelId).not.toHaveBeenCalled();
    expect(Win.made).toHaveLength(0);
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

  it('registers the URL scheme named for the instance', async () => {
    await loadMain('darwin');
    expect(h.electron.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('boundary');
  });
});

describe('quitting', () => {
  it('keeps the window for the quit screen, stops the stack, then exits (Cmd+Q)', async () => {
    vi.useFakeTimers();
    await loadMain();
    const win = await readyWithFakeTimers();
    h.state.appHandlers['before-quit']({ preventDefault: vi.fn() });
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.services.stopHostBridge).toHaveBeenCalledOnce();
    expect(h.services.stopAssistantStack).toHaveBeenCalledOnce();
    expect(h.services.dockerDestroy).toHaveBeenCalled();
    expect(h.electron.app.exit).toHaveBeenCalledWith(0);
  });

  it('lets the window close instead of hiding it while quitting with the desktop button on', async () => {
    config().set('desktopAgentButton', true);
    await loadMain();
    const win = await ready();
    h.state.appHandlers['before-quit']({ preventDefault: vi.fn() });
    expect(h.services.closeDesktopAgentWindows).toHaveBeenCalled();
    closeEvent(win);
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('restart to install keeps the window while the stack stops, then lets it close for Squirrel', async () => {
    vi.useFakeTimers();
    await loadMain();
    const win = await readyWithFakeTimers();
    const updates = await import('../services/updates/ipcHandlers');
    vi.mocked(updates.registerUpdateHandlers).mock.calls[0][0]();
    expect(closeEvent(win).preventDefault).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.services.stopAssistantStack).toHaveBeenCalledOnce();
    expect(updates.quitAndInstallUpdate).toHaveBeenCalledOnce();
    expect(closeEvent(win).preventDefault).not.toHaveBeenCalled();
  });
});

describe('reopening the window', () => {
  it('a menu command after the window closed reopens it and sends once loaded (G15-10)', async () => {
    await loadMain();
    const first = await ready();
    first.close();
    menuItem('Settings…').click();
    await vi.waitFor(() => expect(Win.made).toHaveLength(2));
    const second = Win.made[1];
    // The window adds one did-finish-load listener; the menu command adds the second.
    await vi.waitFor(() => expect(second.webContents.listeners['did-finish-load']).toHaveLength(2));
    second.webContents.loading = false;
    second.webContents.emit('did-finish-load');
    expect(second.webContents.send).toHaveBeenCalledWith('app:menu-command', 'go-settings');
    expect(first.webContents.send).not.toHaveBeenCalled();
  });

  it('activate shows the main window, never another window', async () => {
    config().set('desktopAgentButton', true);
    await loadMain();
    const win = await ready();
    closeEvent(win);
    // A desktop button window; getAllWindows() makes no promise about order.
    const other = new Win({});
    Win.made = [other, ...Win.made.filter((w) => w !== other)];
    h.state.appHandlers.activate();
    await flush();
    expect(win.show).toHaveBeenCalled();
    expect(other.show).not.toHaveBeenCalled();
  });
});

describe('the desktop button switch (ADR 0058)', () => {
  it('turns background throttling back on when switched off', async () => {
    config().set('desktopAgentButton', true);
    await loadMain();
    const win = await ready();
    await h.state.ipcHandlers['desktop-agent:set']({}, false);
    expect(win.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it('shows the hidden window, then closes the desktop windows, when switched off', async () => {
    config().set('desktopAgentButton', true);
    await loadMain();
    const win = await ready();
    closeEvent(win);
    win.show.mockClear();
    const order: string[] = [];
    win.show.mockImplementation(() => order.push('show'));
    h.services.closeDesktopAgentWindows.mockImplementation(() => order.push('close desktop windows'));
    await h.state.ipcHandlers['desktop-agent:set']({}, false);
    expect(order).toEqual(['show', 'close desktop windows']);
  });
});
