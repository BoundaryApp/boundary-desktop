// First: the lag probe times IPC handlers, so it must patch ipcMain before any register.
import { startLagProbe } from './perf/lagProbe';
import { APP_COMMANDS, APP_MENU_COMMAND_CHANNEL, type AppCommand } from '../shared/appCommands';
import { THEME_WINDOW_BACKGROUND, isThemePreference, type ThemePreference } from '../shared/theme';
import { persistDebugLog, serializeError, getDebugLogPath, fileStatForLog } from './persistDebugLog';
import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import started from 'electron-squirrel-startup';
import Store from 'electron-store';
import { initializeDatabase } from './db/connection';
import { taskService } from './services/taskService';
import { dockerService } from './services/dockerService';
import { createFileLogger } from '../shared/utils/logger';
import { registerOnboardingHandlers } from './services/onboarding/ipcHandlers';
import { registerCapabilityHandlers } from './services/capability/ipcHandlers';
import { registerSetupHandlers } from './services/setup/ipcHandlers';
import { registerAssistantStackHandlers } from './services/assistant/ipcHandlers';
import { registerResourceHandlers } from './services/resources/ipcHandlers';
import { registerHermesChatHandlers } from './services/assistant/hermes/hermesChatIpc';
import { installBoardWebviewGuards } from './services/assistant/hermes/hermesBoard';
import { registerHermesVaultHandlers } from './services/assistant/hermes/hermesVaultIpc';
import { registerCalendarHandlers } from './services/assistant/calendar/calendarIpc';
import { startCalendarHealthChecks } from './services/assistant/calendar/calendarService';
import { registerHostBridgeHandlers } from './services/hostBridge/ipcHandlers';
import { ensureHostBridgeStarted, stopHostBridge } from './services/hostBridge/hostBridgeService';
import {
  announceAssistantStackStopping,
  ensureAssistantStackOnLaunch,
  stopAssistantStack,
} from './services/assistant/AssistantStackService';
import { startLocalLlmWatcher } from './services/onboarding/LocalLlmWatcher';
import { configureResolveAppPathStore } from './services/resolveAppPath';
import { infrastructureService } from './services/infrastructure/InfrastructureService';
import { stackStatusService } from './services/infrastructure/StackStatusService';
import { listInstances as listInfraInstances } from './services/infrastructure/instanceStore';
import { migrateLegacyConfigSecrets } from './services/config/SecureConfigStore';
import { claimSingleInstance } from './singleInstance';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const log = createFileLogger(import.meta.url);

/** Directory of this main-process bundle (`.vite/build` in both forge start and packaged asar). */
const mainProcessDir = path.dirname(fileURLToPath(import.meta.url));

/** After first `before-quit` pass we defer quit until the stack stops; second pass must not preventDefault. */
let isElectronQuitAfterShutdown = false;

function registerMainProcessShutdownHooks(): void {
  let uncaughtShutdownStarted = false;
  process.on('uncaughtException', (err) => {
    persistDebugLog('startup', 'uncaughtException', serializeError(err));
    console.error('Main process uncaughtException:', err);
    if (uncaughtShutdownStarted) {
      process.exit(1);
    }
    uncaughtShutdownStarted = true;
    try {
      dockerService.destroy();
    } catch (e) {
      console.warn('dockerService.destroy after uncaughtException:', e);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const rejection = reason instanceof Error ? reason : new Error(String(reason));
    persistDebugLog('startup', 'unhandledRejection', serializeError(rejection));
    console.error('Main process unhandledRejection:', reason);
    if (uncaughtShutdownStarted) {
      process.exit(1);
    }
    uncaughtShutdownStarted = true;
    try {
      dockerService.destroy();
    } catch (e) {
      console.warn('dockerService.destroy after unhandledRejection:', e);
    }
    process.exit(1);
  });

  if (process.platform !== 'win32') {
    let signalShutdownStarted = false;
    const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
      persistDebugLog('startup', `signal ${signal}`, { appReady: app.isReady() });
      if (signalShutdownStarted) {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
      signalShutdownStarted = true;
      if (app.isReady()) {
        app.quit();
        return;
      }
      try {
        dockerService.destroy();
      } catch (e) {
        console.warn(`dockerService.destroy after ${signal}:`, e);
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  }
}

registerMainProcessShutdownHooks();

persistDebugLog('startup', 'main module boot', {
  pid: process.pid,
  ppid: process.ppid,
  ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
  argv: process.argv,
});

process.on('exit', (code) => {
  persistDebugLog('startup', 'process.exit', { code });
});
process.on('beforeExit', (code) => {
  persistDebugLog('startup', 'process.beforeExit', { code });
});

app.on('child-process-gone', (_event, details) => {
  persistDebugLog('startup', 'child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
    serviceName: details.serviceName,
  });
});
app.on('render-process-gone', (_event, _webContents, details) => {
  persistDebugLog('startup', 'render-process-gone', {
    reason: details.reason,
    exitCode: details.exitCode,
  });
});

// Type declarations for global variables
declare global {
  var mainWindow: Electron.BrowserWindow | undefined;
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
persistDebugLog('startup', 'electron-squirrel-startup', {
  started: Boolean(started),
  platform: process.platform,
  argv: process.argv,
});
if (started) {
  persistDebugLog('startup', 'quitting due to squirrel startup', {});
  app.quit();
}

// Ensure proper app name for macOS
if (process.platform === 'darwin') {
  // Set the app name early
  app.setName('Boundary');
  
  // Set the app user model ID for Windows compatibility
  app.setAppUserModelId('com.boundary.desktop');
}

// macOS specific app configuration
if (process.platform === 'darwin') {
  // Set the app name for macOS
  app.setName('Boundary');
  
  // Enable macOS integration
  app.setAsDefaultProtocolClient('boundary');
}

// After setName: the lock lives in userData, which the app name decides.
const isPrimaryInstance = claimSingleInstance(app, () => {
  void showMainWindow();
});

// Check if we're in development mode
const isDevelopment = process.env.NODE_ENV === 'development' || 
                     process.env.ENVIRONMENT === 'dev' || 
                     process.env.ENVIRONMENT === 'development';

if (isDevelopment && process.stdin) {
  process.stdin.on('end', () => {
    persistDebugLog('startup', 'stdin ended; quitting in development', { appReady: app.isReady() });
    if (app.isReady()) {
      app.quit();
    }
  });
}

// Initialize electron-store for configuration
const store = new Store({
  name: 'boundary-config',
  defaults: {
    webhookUrl: '',
    registryUrl: 'http://localhost:3001',
    localAppDirectories: [] as string[], // Store local app directories
    themePreference: 'system' as string, // Appearance: system | light | dark
    windowBounds: {
      x: undefined,
      y: undefined,
      width: 1800,
      height: 1250
    }
  }
});

configureResolveAppPathStore(store as unknown as Store<Record<string, unknown>>);

async function saveMacDisplayForQuit(): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (!global.mainWindow || global.mainWindow.isDestroyed()) return;
  const bounds = global.mainWindow.getBounds();
  const { screen } = await import('electron');
  const currentDisplay = screen.getDisplayNearestPoint(bounds);
  if (currentDisplay) {
    store.set('lastDisplayId', currentDisplay.id);
    log('Saved display info for Space persistence');
  }
}

// Note: Database initialization is now handled in the 'ready' event
// to ensure it completes before the window is created

// IPC handlers for configuration management
// Appearance: the stored preference drives nativeTheme (title bar, menus,
// prefers-color-scheme in the renderer) and the window's pre-paint background.
const readThemePreference = (): ThemePreference => {
  const stored = store.get('themePreference', 'system');
  return isThemePreference(stored) ? stored : 'system';
};

const themeWindowBackground = (): string =>
  THEME_WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

let nativeThemeInitialized = false;
const initNativeTheme = () => {
  if (nativeThemeInitialized) return;
  nativeThemeInitialized = true;
  nativeTheme.themeSource = readThemePreference();
  nativeTheme.on('updated', () => {
    if (global.mainWindow && !global.mainWindow.isDestroyed()) {
      global.mainWindow.setBackgroundColor(themeWindowBackground());
    }
  });
};

ipcMain.handle('appearance:get-theme', () => readThemePreference());

ipcMain.handle('appearance:set-theme', (_event, preference: unknown) => {
  if (!isThemePreference(preference)) {
    return { success: false, error: 'Unknown theme preference.' };
  }
  store.set('themePreference', preference);
  nativeTheme.themeSource = preference;
  return { success: true };
});

registerOnboardingHandlers();
registerCapabilityHandlers();
registerSetupHandlers();
registerAssistantStackHandlers();
registerResourceHandlers();
registerHermesChatHandlers();
registerHermesVaultHandlers();
registerCalendarHandlers();
startCalendarHealthChecks();
registerHostBridgeHandlers();
startLocalLlmWatcher();

// IPC handlers for task management
ipcMain.handle('task:get', async (event, id: string) => {
  try {
    return await taskService.getTask(id);
  } catch (error) {
    console.error('Error getting task:', error);
    throw error;
  }
});

// IPC handlers for Terraform infrastructure stacks
ipcMain.handle('infrastructure:list-catalog', async () => {
  try {
    return await infrastructureService.listCatalog();
  } catch (error) {
    log('infrastructure:list-catalog error:', error);
    throw error;
  }
});

ipcMain.handle('infrastructure:list-manifests', async () => {
  try {
    return await infrastructureService.listManifests();
  } catch (error) {
    log('infrastructure:list-manifests error:', error);
    throw error;
  }
});

ipcMain.handle('infrastructure:list-instances', async () => {
  try {
    return await infrastructureService.listInstances();
  } catch (error) {
    log('infrastructure:list-instances error:', error);
    throw error;
  }
});

ipcMain.handle(
  'infrastructure:create-instance',
  async (
    _event,
    arg: string | { modelId: string; provider: string; displayName?: string; stackTypeId?: string },
    displayName?: string
  ) => {
    if (typeof arg === 'string') {
      return infrastructureService.createInstance(arg, displayName);
    }
    if ('stackTypeId' in arg && arg.stackTypeId && !arg.modelId) {
      return infrastructureService.createInstance({
        stackTypeId: arg.stackTypeId,
        displayName: arg.displayName,
      });
    }
    return infrastructureService.createInstance({
      ...arg,
      provider: arg.provider as import('../shared/types/infrastructure').ProviderId,
    });
  }
);

ipcMain.handle(
  'infrastructure:check-prerequisites',
  async (_event, provider: string, modelId?: string) => {
    return infrastructureService.checkPrerequisites(
      provider as import('../shared/types/infrastructure').ProviderId,
      modelId
    );
  }
);

ipcMain.handle('infrastructure:delete-instance', async (_event, instanceId: string) => {
  return infrastructureService.deleteInstance(instanceId);
});

ipcMain.handle('infrastructure:get-vars', async (_event, instanceId: string) => {
  return infrastructureService.getVars(instanceId);
});

ipcMain.handle(
  'infrastructure:save-vars',
  async (_event, instanceId: string, vars: Record<string, string | number | boolean>) => {
    return infrastructureService.saveVars(instanceId, vars);
  }
);

ipcMain.handle(
  'infrastructure:set-secret',
  async (_event, instanceId: string, varName: string, value: string) => {
    return infrastructureService.setSecret(instanceId, varName, value);
  }
);

ipcMain.handle('infrastructure:apply', async (_event, instanceId: string) => {
  return infrastructureService.apply(instanceId);
});

ipcMain.handle(
  'infrastructure:destroy',
  async (
    _event,
    instanceId: string,
    payload: { confirm: boolean; confirmName?: string }
  ) => {
    return infrastructureService.destroy(
      instanceId,
      payload?.confirm === true,
      payload?.confirmName
    );
  }
);

ipcMain.handle('infrastructure:cancel', async (_event, instanceId: string) => {
  return infrastructureService.cancel(instanceId);
});

ipcMain.handle('infrastructure:get-status', async (_event, instanceId: string) => {
  return infrastructureService.getStatus(instanceId);
});

ipcMain.handle('infrastructure:get-runtime', async (_event, instanceId: string) => {
  return infrastructureService.getRuntime(instanceId);
});

ipcMain.handle('infrastructure:check-terraform', async () => {
  return infrastructureService.checkTerraform();
});

ipcMain.handle('infrastructure:check-truss', async () => {
  return infrastructureService.checkTruss();
});

ipcMain.handle('infrastructure:subscribe', async (event) => {
  stackStatusService.addSubscriber(event.sender.id);
  return { success: true };
});

ipcMain.handle('infrastructure:unsubscribe', async (event) => {
  stackStatusService.removeSubscriber(event.sender.id);
  return { success: true };
});

if (isDevelopment) {
  ipcMain.handle('urls:open-url', async (event, url: string) => {
    try {
      const { shell } = await import('electron');
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error('Error opening URL:', error);
      return { success: false, error: error.message };
    }
  });
}

const createWindow = async () => {
  // Get saved window bounds
  const windowBounds = store.get('windowBounds', {
    x: undefined,
    y: undefined,
    width: 1800,
    height: 1250
  }) as { x?: number; y?: number; width: number; height: number };

  // Ensure window is within screen bounds
  const { screen } = await import('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  // Check if we have a saved display ID (for Space persistence)
  const lastDisplayId = store.get('lastDisplayId') as number | undefined;
  let targetDisplay = primaryDisplay;
  
  if (lastDisplayId !== undefined) {
    const displays = screen.getAllDisplays();
    const savedDisplay = displays.find((d: any) => d.id === lastDisplayId);
    if (savedDisplay) {
      targetDisplay = savedDisplay;
      log('Restoring window to saved display:', savedDisplay.id);
    }
  }

  // If window position is off-screen or not set, center it on the target display
  if (windowBounds.x === undefined || windowBounds.y === undefined ||
      windowBounds.x < 0 || windowBounds.y < 0 ||
      windowBounds.x + windowBounds.width > screenWidth ||
      windowBounds.y + windowBounds.height > screenHeight) {
    const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = targetDisplay.workArea;
    windowBounds.x = Math.floor(displayX + (displayWidth - windowBounds.width) / 2);
    windowBounds.y = Math.floor(displayY + (displayHeight - windowBounds.height) / 2);
  }

  // Resolve preload/renderer from this bundle's directory — never process.cwd().
  // Packaged launches via `open` often have cwd `/`, which broke UI loading.
  const preloadPath = path.join(mainProcessDir, 'preload.js');
  const rendererIndexPath = path.join(
    mainProcessDir,
    `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`
  );
  persistDebugLog('startup', 'createWindow paths', {
    mainProcessDir,
    preloadPath,
    rendererIndexPath,
    preload: fileStatForLog(preloadPath),
    rendererIndex: fileStatForLog(rendererIndexPath),
    viteName: String(MAIN_WINDOW_VITE_NAME),
    hasDevServer: Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL),
  });

  initNativeTheme();
  const macInsetChrome = process.platform === 'darwin';

  // Create the browser window.
  global.mainWindow = new BrowserWindow({
    x: windowBounds.x,
    y: windowBounds.y,
    width: windowBounds.width,
    height: windowBounds.height,
    // Product chrome draws its own dark title area; traffic lights centre on the
    // 42px thread header.
    titleBarStyle: macInsetChrome ? 'hiddenInset' : 'default',
    ...(macInsetChrome ? { trafficLightPosition: { x: 16, y: 15 } } : {}),
    show: false, // Don't show until ready
    alwaysOnTop: false,
    skipTaskbar: false,
    // Ensure proper macOS app behavior
    autoHideMenuBar: false,
    // Set proper window title
    title: 'Boundary',
    // Matches --surface-0 for the active theme so the first paint does not flash.
    backgroundColor: themeWindowBackground(),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // The Tasks pane's board view. installBoardWebviewGuards limits it to the Hermes board.
      webviewTag: true,
    },
  });
  installBoardWebviewGuards(global.mainWindow);

  // Show window when ready to prevent flashing
  const readyToShowTimer = setTimeout(() => {
    persistDebugLog('startup', 'ready-to-show not fired within 8s', {
      destroyed: global.mainWindow?.isDestroyed() ?? true,
      url: global.mainWindow && !global.mainWindow.isDestroyed()
        ? global.mainWindow.webContents.getURL()
        : null,
    });
  }, 8_000);

  global.mainWindow!.once('ready-to-show', () => {
    clearTimeout(readyToShowTimer);
    persistDebugLog('startup', 'ready-to-show', {
      title: global.mainWindow?.getTitle(),
    });
    // Show the window
    global.mainWindow!.show();
    global.mainWindow!.focus();
    
    // Ensure the app is properly activated
    app.focus();
  });

  global.mainWindow!.on('closed', () => {
    persistDebugLog('startup', 'main window closed', {});
  });
  global.mainWindow!.on('close', (e) => {
    persistDebugLog('startup', 'main window close requested', {
      isElectronQuitAfterShutdown,
    });
    // Keep the window alive while containers shut down so the quit overlay can render.
    // `app.exit(0)` ends the process after cleanup without needing this close to complete.
    if (isElectronQuitAfterShutdown) {
      e.preventDefault();
    }
  });
  global.mainWindow!.on('unresponsive', () => {
    persistDebugLog('startup', 'main window unresponsive', {});
  });
  global.mainWindow!.webContents.on('did-finish-load', () => {
    persistDebugLog('startup', 'renderer did-finish-load', {
      url: global.mainWindow?.webContents.getURL(),
    });
  });
  global.mainWindow!.webContents.on('render-process-gone', (_event, details) => {
    persistDebugLog('startup', 'window render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  global.mainWindow!.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    persistDebugLog('startup', 'renderer did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL,
    });
    console.error('Renderer failed to load:', errorCode, errorDescription, validatedURL);
  });

  // Save window bounds when window is moved or resized
  const saveWindowBounds = () => {
    if (global.mainWindow && !global.mainWindow.isDestroyed()) {
      const bounds = global.mainWindow.getBounds();
      store.set('windowBounds', bounds);
    }
  };

  // Save bounds on move and resize
  global.mainWindow!.on('move', saveWindowBounds);
  global.mainWindow!.on('resize', saveWindowBounds);
  
  // macOS Spaces handling - simplified approach
  if (process.platform === 'darwin') {
    // Save display ID when window is moved to track which display it's on
    global.mainWindow!.on('move', () => {
      saveWindowBounds();
      
      // Save the current display ID for restoration
      const { screen } = require('electron');
      const displays = screen.getAllDisplays();
      const currentDisplay = screen.getDisplayNearestPoint(global.mainWindow!.getBounds());
      if (currentDisplay) {
        store.set('lastDisplayId', currentDisplay.id);
      }
    });
    
    // Handle window focus to ensure proper activation
    global.mainWindow!.on('focus', () => {
      // Ensure window is properly focused and activated
      app.focus();
    });
  }

  // Set Content Security Policy
  global.mainWindow!.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const connectSrcExtras = isDevelopment ? ' http://127.0.0.1:*' : '';
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss: http://localhost:* https://localhost:*${connectSrcExtras}; font-src 'self' data:; frame-src 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*;`
        ]
      }
    });
  });

  // and load the index.html of the app.
  persistDebugLog('startup', 'loading renderer', {
    mode: MAIN_WINDOW_VITE_DEV_SERVER_URL ? 'dev-server' : 'file',
    url: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? rendererIndexPath,
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    global.mainWindow!.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    global.mainWindow!.loadFile(rendererIndexPath);
  }

  // Enable context menu for development
  if (isDevelopment) {
    // Create context menu
    const { Menu, MenuItem } = await import('electron');
    
    // Store the last context menu coordinates
    let lastContextMenuCoords = { x: 0, y: 0 };
    
    const contextMenu = new Menu();
    contextMenu.append(new MenuItem({
      label: 'Inspect Element',
      click: () => {
        global.mainWindow!.webContents.inspectElement(lastContextMenuCoords.x, lastContextMenuCoords.y);
      }
    }));
    
    contextMenu.append(new MenuItem({
      label: 'Reload',
      click: () => {
        global.mainWindow!.reload();
      }
    }));
    
    contextMenu.append(new MenuItem({
      label: 'Toggle DevTools',
      click: () => {
        global.mainWindow!.webContents.toggleDevTools();
      }
    }));
    
    // Add context menu to webContents
    global.mainWindow!.webContents.on('context-menu', (event, params) => {
      // Store the coordinates where the context menu was triggered
      lastContextMenuCoords = { x: params.x, y: params.y };
      contextMenu.popup();
    });
  }

  // Do not auto-open DevTools: a second Chromium renderer plus retained console
  // output is a large share of macOS application memory. Use View → Toggle
  // Developer Tools, or set ELECTRON_OPEN_DEVTOOLS=1.
  if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
    try {
      persistDebugLog('startup', 'opening DevTools', { reason: 'ELECTRON_OPEN_DEVTOOLS=1' });
      global.mainWindow!.webContents.openDevTools();
    } catch (error) {
      persistDebugLog('startup', 'openDevTools failed', serializeError(error));
    }
  }
};

// Create application menu
const createMenu = () => {
  // App commands show their shortcut in the menu bar but leave the key press to
  // the renderer (registerAccelerator: false), which owns focus-aware handling.
  const sendCommand = (id: AppCommand) => () => {
    global.mainWindow?.webContents.send(APP_MENU_COMMAND_CHANNEL, id);
  };
  const commandItem = (id: AppCommand): Electron.MenuItemConstructorOptions => {
    const def = APP_COMMANDS.find((command) => command.id === id);
    return {
      label: def?.label ?? id,
      accelerator: def?.accelerator,
      registerAccelerator: false,
      click: sendCommand(id),
    };
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Boundary',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { ...commandItem('go-settings'), label: 'Settings…' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [commandItem('new-chat')],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Go',
      submenu: [
        commandItem('go-chat'),
        commandItem('go-services'),
        commandItem('go-resources'),
        { type: 'separator' },
        commandItem('prev-thread'),
        commandItem('next-thread'),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if (!isPrimaryInstance) return;
  startLagProbe();
  persistDebugLog('startup', 'app ready entered', {
    isPackaged: app.isPackaged,
    isDevelopment,
    cwd: process.cwd(),
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
    temp: app.getPath('temp'),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath ?? null,
    debugLogPath: getDebugLogPath(),
    version: app.getVersion(),
    locale: app.getLocale(),
  });
  // Create the application menu
  createMenu();
  await migrateLegacyConfigSecrets(store as unknown as Store<Record<string, unknown>>);
  
  // Ensure proper macOS app behavior
  if (process.platform === 'darwin') {
    // Set the app name again to ensure it's properly registered
    app.setName('Boundary');
    
    // Ensure the dock shows the app
    if (app.dock) {
      app.dock.show();
    }
  }
  
  // Wait for database initialization before creating the window
  try {
    persistDebugLog('startup', 'initializeDatabase begin', {
      userData: app.getPath('userData'),
      userDataStat: fileStatForLog(app.getPath('userData')),
    });
    await initializeDatabase();
    persistDebugLog('startup', 'initializeDatabase succeeded', {
      dbDir: fileStatForLog(path.join(app.getPath('userData'), 'db')),
      dbFile: fileStatForLog(path.join(app.getPath('userData'), 'db', 'boundary.db')),
    });
    log('Database initialized successfully');

    const infraInstances = await listInfraInstances();
    for (const inst of infraInstances) {
      stackStatusService.registerInstance(inst.id);
    }

    await createWindow();
    persistDebugLog('startup', 'createWindow returned', {
      hasWindow: Boolean(global.mainWindow && !global.mainWindow.isDestroyed()),
    });

    // Host bridge (ADR 0027). The stack's Hermes config step waits for it too.
    void ensureHostBridgeStarted().catch((error) => {
      console.warn('[host-bridge] Start failed:', error);
    });

    void ensureAssistantStackOnLaunch().catch((error) => {
      console.warn('[assistant-stack] Launch ensure failed:', error);
    });
  } catch (error) {
    persistDebugLog('startup', 'ready try/catch quitting app (first-launch candidate)', {
      ...serializeError(error),
    });
    console.error('Failed to initialize database:', error);
    app.quit();
  }
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  persistDebugLog('startup', 'window-all-closed', {
    platform: process.platform,
    isDevelopment,
    isElectronQuitAfterShutdown,
    willQuit: process.platform !== 'darwin' || isDevelopment || isElectronQuitAfterShutdown,
    windowCount: BrowserWindow.getAllWindows().length,
  });
  // In dev, quit on macOS too so electron-forge child exit releases the terminal.
  // Also finish an in-progress Cmd+Q: preventDefault + app.quit() otherwise closes
  // windows and leaves a Dock zombie that the next `open` activates.
  if (process.platform !== 'darwin' || isDevelopment || isElectronQuitAfterShutdown) {
    app.quit();
  }
  // On macOS production, don't quit when all windows are closed (dock stays active).
});

/** Re-create the window if none is open, else bring the existing one forward. */
async function showMainWindow(): Promise<void> {
  if (!app.isReady()) return;
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  } else {
    // On macOS, focus the existing window instead of creating a new one
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const mainWindow = windows[0];
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  }
  
  // Ensure the app is properly activated
  app.focus();
}

app.on('activate', () => {
  persistDebugLog('startup', 'activate', {
    windowCount: BrowserWindow.getAllWindows().length,
  });
  void showMainWindow();
});

app.on('before-quit', (e) => {
  persistDebugLog('startup', 'before-quit', {
    isElectronQuitAfterShutdown,
    hasMainWindow: Boolean(global.mainWindow && !global.mainWindow.isDestroyed()),
  });
  if (isElectronQuitAfterShutdown) {
    return;
  }
  e.preventDefault();
  isElectronQuitAfterShutdown = true;

  // Show quit overlay before any teardown so progress events have a live window.
  try {
    announceAssistantStackStopping();
  } catch (error) {
    log('Error announcing assistant stack stop:', error);
  }
  if (global.mainWindow && !global.mainWindow.isDestroyed()) {
    global.mainWindow.show();
  }

  void (async () => {
    // Milliseconds per quit step, logged on exit so a slow quit names its step.
    const stepMs: Record<string, number> = {};
    const timed = async (step: string, run: () => Promise<unknown>) => {
      const startedAt = Date.now();
      try {
        await run();
      } finally {
        stepMs[step] = Date.now() - startedAt;
      }
    };
    // Brief yield so the renderer can paint the quit overlay.
    await new Promise((r) => setTimeout(r, 150));
    try {
      await timed('saveDisplay', saveMacDisplayForQuit);
      try {
        await timed('hostBridge', stopHostBridge);
      } catch (error) {
        log('Error stopping host bridge during quit:', error);
      }
      try {
        await timed('assistantStack', stopAssistantStack);
      } catch (error) {
        log('Error stopping assistant stack during quit:', error);
      }
    } catch (error) {
      log('Error during pre-quit shutdown:', error);
    } finally {
      const destroyStartedAt = Date.now();
      try {
        dockerService.destroy();
      } catch (error) {
        console.warn('Error destroying Docker service:', error);
      }
      stepMs.dockerDestroy = Date.now() - destroyStartedAt;
      persistDebugLog('startup', 'before-quit cleanup done, app.exit', { stepMs });
      // app.quit() after preventDefault can close windows without exiting on macOS.
      app.exit(0);
    }
  })();
});

// Handle app quit properly
app.on('quit', () => {
  persistDebugLog('startup', 'quit', {});
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
