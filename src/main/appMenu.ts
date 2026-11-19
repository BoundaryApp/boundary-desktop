import { Menu } from 'electron';
import { APP_COMMANDS, type AppCommand } from '../shared/appCommands';
import { APP_NAME } from '../shared/buildIdentity';
import { sendEvent } from './ipc';
import { persistDebugLog, serializeError } from './persistDebugLog';
import { setButtonHidden } from './services/desktopAgent/desktopAgentWindows';
import { updateMenuItem } from './services/updates/ipcHandlers';
import { getMainWindow, showMainWindow } from './services/windows';

/**
 * App commands show their shortcut in the menu bar but leave the key press to the renderer
 * (registerAccelerator: false), which owns focus-aware handling.
 */
function sendCommand(id: AppCommand): () => void {
  return () => {
    const win = getMainWindow();
    if (win) {
      sendEvent(win.webContents, 'app:menu-command', id);
      return;
    }
    // The window was closed (macOS keeps the app running): reopen it and send once it has loaded.
    void showMainWindow()
      .then((reopened) => {
        if (!reopened) return;
        const send = () => sendEvent(reopened.webContents, 'app:menu-command', id);
        if (reopened.webContents.isLoading()) {
          reopened.webContents.once('did-finish-load', send);
        } else {
          send();
        }
      })
      .catch((error) => {
        persistDebugLog('startup', 'menu command could not reopen the window', serializeError(error));
      });
  };
}

function commandItem(id: AppCommand): Electron.MenuItemConstructorOptions {
  const def = APP_COMMANDS.find((command) => command.id === id);
  return {
    label: def?.label ?? id,
    accelerator: def?.accelerator,
    registerAccelerator: false,
    click: sendCommand(id),
  };
}

/** Build and set the application menu. Called again when the update item changes. */
export function createAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        updateMenuItem(),
        { type: 'separator' },
        { ...commandItem('go-settings'), label: 'Settings…' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [commandItem('new-chat'), commandItem('toggle-agent')],
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
        { role: 'selectAll' },
      ],
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
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        commandItem('go-chat'),
        commandItem('go-circles'),
        commandItem('go-inference'),
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
        { role: 'close' },
        ...(process.platform === 'darwin'
          ? [{ type: 'separator' as const }, { label: 'Show Agent Button', click: () => setButtonHidden(false) }]
          : []),
      ],
    },
    {
      role: 'help',
      submenu: [commandItem('report-bug')],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
