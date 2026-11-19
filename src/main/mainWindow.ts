import { app, BrowserWindow, type Display } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_NAME } from '../shared/buildIdentity';
import { createFileLogger, debugArgForWindow } from '../shared/utils/logger';
import { appUrlMatcher } from './appUrl';
import { initNativeTheme, themeWindowBackground } from './appearance';
import { watchRingWindow } from './callRingAlerts';
import type { ConfigStore, WindowBounds } from './configStore';
import { sendEvent } from './ipc';
import { openHttpUrlExternally } from './openExternal';
import { fileStatForLog, persistDebugLog, serializeError } from './persistDebugLog';
import { isInstallingUpdate, isQuitting } from './quit';
import { shouldBlockSandboxedFrameNavigation } from './sandboxedFrameNavigation';
import { attachSmokeExit, isSmokeRun, type SmokeDeps } from './smokeExit';
import { installBoardWebviewGuards } from './services/assistant/hermes/hermesBoard';
import { desktopAgentOn } from './services/desktopAgent/ipcHandlers';
import {
  adoptDesktopAgentWindow,
  closeDesktopAgentWindows,
  desktopAgentOpenResponse,
} from './services/desktopAgent/desktopAgentWindows';
import { shouldHideOnClose } from './services/desktopAgent/windowLifecycle';
import { installPermissionHandlers } from './services/media';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

declare global {
  var mainWindow: Electron.BrowserWindow | undefined;
}

const log = createFileLogger(import.meta.url);

/** Directory of this main-process bundle (`.vite/build` in both forge start and packaged asar). */
const mainProcessDir = path.dirname(fileURLToPath(import.meta.url));

type DisplayArea = Pick<Display, 'id' | 'workArea'>;

/**
 * Where the main window opens: the saved bounds on the saved display (the primary display when
 * none is saved or it is gone). Bounds unset or not inside that display's work area are centred
 * on it.
 */
export function restoredBounds(
  saved: WindowBounds,
  lastDisplayId: number | undefined,
  displays: DisplayArea[],
  primary: DisplayArea
): Required<WindowBounds> {
  const target = displays.find((d) => d.id === lastDisplayId) ?? primary;
  const area = target.workArea;
  const { x, y, width, height } = saved;
  if (
    x !== undefined &&
    y !== undefined &&
    x >= area.x &&
    y >= area.y &&
    x + width <= area.x + area.width &&
    y + height <= area.y + area.height
  ) {
    return { x, y, width, height };
  }
  return {
    x: Math.floor(area.x + (area.width - width) / 2),
    y: Math.floor(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** Save the display the main window is on, so it reopens there (macOS Spaces). */
export async function saveDisplayForQuit(store: ConfigStore): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (!global.mainWindow || global.mainWindow.isDestroyed()) return;
  const { screen } = await import('electron');
  const currentDisplay = screen.getDisplayNearestPoint(global.mainWindow.getBounds());
  if (currentDisplay) {
    store.set('lastDisplayId', currentDisplay.id);
    log('Saved display info for Space persistence');
  }
}

export interface MainWindowDeps {
  store: ConfigStore;
  isDevelopment: boolean;
  smokeDeps: SmokeDeps;
}

/** Content Security Policy for the app's page. Development also allows the dev stack on 127.0.0.1. */
function contentSecurityPolicy(isDevelopment: boolean): string {
  const connectSrcExtras = isDevelopment ? ' http://127.0.0.1:*' : '';
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss: http://localhost:* https://localhost:*${connectSrcExtras}; font-src 'self' data:; frame-src 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*;`;
}

/** Build the main window, with its bounds restored, and load the app into it. */
export function createMainWindowFactory({ store, isDevelopment, smokeDeps }: MainWindowDeps): () => Promise<void> {
  return async () => {
    const { screen } = await import('electron');
    const lastDisplayId = store.get('lastDisplayId');
    const displays = screen.getAllDisplays();
    if (displays.some((d) => d.id === lastDisplayId)) {
      log('Restoring window to saved display:', lastDisplayId);
    }
    const windowBounds = restoredBounds(
      store.get('windowBounds'),
      lastDisplayId,
      displays,
      screen.getPrimaryDisplay()
    );

    // Resolve preload/renderer from this bundle's directory — never process.cwd().
    // Packaged launches via `open` often have cwd `/`, which broke UI loading.
    const preloadPath = path.join(mainProcessDir, 'preload.cjs');
    const rendererIndexPath = path.join(mainProcessDir, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    persistDebugLog('startup', 'createWindow paths', {
      mainProcessDir,
      preloadPath,
      rendererIndexPath,
      preload: fileStatForLog(preloadPath),
      rendererIndex: fileStatForLog(rendererIndexPath),
      viteName: String(MAIN_WINDOW_VITE_NAME),
      hasDevServer: Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL),
    });

    initNativeTheme(store);
    const macInsetChrome = process.platform === 'darwin';

    const win = new BrowserWindow({
      ...windowBounds,
      // Product chrome draws its own dark title area; traffic lights centre on the
      // 42px thread header.
      titleBarStyle: macInsetChrome ? 'hiddenInset' : 'default',
      ...(macInsetChrome ? { trafficLightPosition: { x: 16, y: 15 } } : {}),
      show: false, // Shown on ready-to-show, so it doesn't flash.
      alwaysOnTop: false,
      skipTaskbar: false,
      autoHideMenuBar: false,
      title: APP_NAME,
      // Matches --surface-0 for the active theme so the first paint does not flash.
      backgroundColor: themeWindowBackground(),
      webPreferences: {
        preload: preloadPath,
        // Preload and renderer loggers follow main's DEBUG value (see shared/utils/logger.ts).
        additionalArguments: [debugArgForWindow()],
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        // The Tasks pane's board view. installBoardWebviewGuards limits it to the Hermes board.
        webviewTag: true,
        // With the desktop button on, the page keeps running while the window is hidden, so a
        // reply keeps streaming into the panel (ADR 0058 §1).
        backgroundThrottling: !desktopAgentOn(store),
      },
    });
    global.mainWindow = win;
    installBoardWebviewGuards(win);

    // The window shows only the app. New windows and navigation elsewhere are refused, and
    // http(s) targets open in the system browser instead. Only the app's page gets web permissions.
    const appUrl = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(rendererIndexPath).href);
    const isAppUrl = appUrlMatcher(appUrl);
    installPermissionHandlers(win.webContents.session, isAppUrl);
    win.webContents.setWindowOpenHandler(({ url, frameName }) => {
      // The desktop button and panel, which the page draws into (ADR 0058).
      const desktop = desktopAgentOpenResponse(frameName, url);
      if (desktop) return desktop as Electron.WindowOpenHandlerResponse;
      void openHttpUrlExternally(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-create-window', (child, { frameName }) => {
      // The desktop windows carry the app's preload, so they open nothing and load nothing else:
      // a link in them goes to the system browser, as it does from the app window.
      child.webContents.setWindowOpenHandler(({ url }) => {
        void openHttpUrlExternally(url);
        return { action: 'deny' };
      });
      child.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        void openHttpUrlExternally(url);
      });
      adoptDesktopAgentWindow(child, frameName);
    });
    // A reload or crash recovery replaces the page that drew them; the new page opens its own.
    win.webContents.on('did-start-navigation', (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame && !details.isSameDocument) closeDesktopAgentWindows();
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      void openHttpUrlExternally(url);
    });

    // A page preview's sandboxed frame must not navigate itself (to a localhost service, say).
    win.webContents.on('will-frame-navigate', (details) => {
      if (
        shouldBlockSandboxedFrameNavigation({
          isMainFrame: details.isMainFrame,
          url: details.url,
          frameOrigin: details.frame?.origin,
        })
      ) {
        details.preventDefault();
      }
    });

    const readyToShowTimer = setTimeout(() => {
      persistDebugLog('startup', 'ready-to-show not fired within 8s', {
        destroyed: win.isDestroyed(),
        url: win.isDestroyed() ? null : win.webContents.getURL(),
      });
    }, 8_000);

    win.once('ready-to-show', () => {
      clearTimeout(readyToShowTimer);
      persistDebugLog('startup', 'ready-to-show', { title: win.getTitle() });
      win.show();
      win.focus();
      app.focus();
    });

    win.on('closed', () => {
      persistDebugLog('startup', 'main window closed', {});
      // On macOS the app outlives the window; nothing should reach the destroyed one.
      if (global.mainWindow === win) {
        global.mainWindow = undefined;
      }
    });
    win.on('close', (e) => {
      persistDebugLog('startup', 'main window close requested', {
        isElectronQuitAfterShutdown: isQuitting(),
      });
      // With the desktop button on, closing hides the window and keeps its page (ADR 0058 §1).
      if (
        shouldHideOnClose({
          switchOn: desktopAgentOn(store),
          platform: process.platform,
          quitting: isQuitting(),
          installingUpdate: isInstallingUpdate(),
        })
      ) {
        e.preventDefault();
        // Hiding a full-screen window leaves its Space black on macOS: leave full screen first.
        if (win.isFullScreen()) {
          win.once('leave-full-screen', () => win.hide());
          win.setFullScreen(false);
        } else {
          win.hide();
        }
        return;
      }
      // Keep the window alive while containers shut down so the quit overlay can render.
      // `app.exit(0)` ends the process after cleanup without needing this close to complete.
      // An update is different: quitAndInstall waits for every window to close.
      if (isQuitting() && !isInstallingUpdate()) {
        e.preventDefault();
      }
    });
    // A ring alerts outside the window only while the window isn't in front.
    watchRingWindow(win);
    // The page pauses work that only matters on screen while the window is hidden.
    win.on('show', () => sendEvent(win.webContents, 'app-window:shown', true));
    win.on('hide', () => sendEvent(win.webContents, 'app-window:shown', false));
    win.on('unresponsive', () => {
      persistDebugLog('startup', 'main window unresponsive', {});
    });
    win.webContents.on('did-finish-load', () => {
      persistDebugLog('startup', 'renderer did-finish-load', { url: win.webContents.getURL() });
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      persistDebugLog('startup', 'window render-process-gone', {
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      persistDebugLog('startup', 'renderer did-fail-load', { errorCode, errorDescription, validatedURL });
      console.error('Renderer failed to load:', errorCode, errorDescription, validatedURL);
    });
    if (isSmokeRun()) {
      attachSmokeExit(win.webContents, smokeDeps);
    }

    const saveWindowBounds = () => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      store.set('windowBounds', bounds);
      // macOS Spaces: remember the display too, so the window reopens on it.
      if (process.platform === 'darwin') {
        store.set('lastDisplayId', screen.getDisplayNearestPoint(bounds).id);
      }
    };
    win.on('move', saveWindowBounds);
    win.on('resize', () => {
      if (!win.isDestroyed()) store.set('windowBounds', win.getBounds());
    });
    if (process.platform === 'darwin') {
      win.on('focus', () => app.focus());
    }

    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [contentSecurityPolicy(isDevelopment)],
        },
      });
    });

    persistDebugLog('startup', 'loading renderer', {
      mode: MAIN_WINDOW_VITE_DEV_SERVER_URL ? 'dev-server' : 'file',
      url: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? rendererIndexPath,
    });
    // Not awaited: the window opens while the renderer loads. A failed load also emits
    // did-fail-load, which is logged above.
    const load = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      : win.loadFile(rendererIndexPath);
    load.catch((error: unknown) => {
      persistDebugLog('startup', 'renderer load rejected', serializeError(error));
    });

    if (isDevelopment) await installDevContextMenu(win);

    // Do not auto-open DevTools: a second Chromium renderer plus retained console
    // output is a large share of macOS application memory. Use View → Toggle
    // Developer Tools, or set ELECTRON_OPEN_DEVTOOLS=1.
    if (process.env.ELECTRON_OPEN_DEVTOOLS === '1') {
      try {
        persistDebugLog('startup', 'opening DevTools', { reason: 'ELECTRON_OPEN_DEVTOOLS=1' });
        win.webContents.openDevTools();
      } catch (error) {
        persistDebugLog('startup', 'openDevTools failed', serializeError(error));
      }
    }
  };
}

/** Development only: Inspect Element, Reload and Toggle DevTools on right-click. */
async function installDevContextMenu(win: BrowserWindow): Promise<void> {
  const { Menu, MenuItem } = await import('electron');
  let lastContextMenuCoords = { x: 0, y: 0 };
  const contextMenu = new Menu();
  contextMenu.append(
    new MenuItem({
      label: 'Inspect Element',
      click: () => win.webContents.inspectElement(lastContextMenuCoords.x, lastContextMenuCoords.y),
    })
  );
  contextMenu.append(new MenuItem({ label: 'Reload', click: () => win.reload() }));
  contextMenu.append(new MenuItem({ label: 'Toggle DevTools', click: () => win.webContents.toggleDevTools() }));
  win.webContents.on('context-menu', (_event, params) => {
    lastContextMenuCoords = { x: params.x, y: params.y };
    contextMenu.popup();
  });
}
