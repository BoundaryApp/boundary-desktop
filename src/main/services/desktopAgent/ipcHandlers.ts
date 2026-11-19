import { app, globalShortcut, Menu, screen, type BrowserWindow } from 'electron';
import { IS_SEPARATE_INSTANCE } from '../../../shared/buildIdentity';
import { AGENT_BUTTON_CORNERS } from '../../../shared/types/desktopAgent';
import { handle, handleResult } from '../../ipc';
import { persistDebugLog } from '../../persistDebugLog';
import { broadcast } from '../windows';
import {
  desktopAgentState,
  isDesktopAgentOn,
  onDesktopAgentChange,
  setDesktopAgentOn,
  type DesktopAgentBuild,
  type DesktopAgentStore,
} from './desktopAgentSetting';
import {
  buttonMenuTemplate,
  buttonWindow,
  dragButton,
  dropButton,
  initDesktopAgentWindows,
  isButtonHidden,
  moveButtonToCorner,
  setButtonHidden,
  type ButtonCorner,
  type DesktopAgentDeps,
} from './desktopAgentWindows';
import { applyPanelShortcut, initPanelShortcut, panelShortcutError, registerPanelShortcut } from './panelShortcut';

/** Where the panel's shortcut from any app is kept. Unset means none. */
const SHORTCUT_KEY = 'desktopAgentShortcut';
type ShortcutStore = { get(key: typeof SHORTCUT_KEY): unknown; set(key: typeof SHORTCUT_KEY, value: string | null): void };

/** Hold the stored shortcut for the switch's position, and log one that couldn't be held. */
function holdShortcut(on: boolean, store: ShortcutStore): void {
  const result = applyPanelShortcut(on, storedShortcut(store));
  if (!result.ok) persistDebugLog('desktop-agent', 'panel shortcut not held', { error: result.error ?? null });
}

function storedShortcut(store: ShortcutStore): string | null {
  const value = store.get(SHORTCUT_KEY);
  return typeof value === 'string' && value ? value : null;
}

const build = (): DesktopAgentBuild => ({ isPackaged: app.isPackaged, isSeparateInstance: IS_SEPARATE_INSTANCE });

const CORNER_NAMES = Object.keys(AGENT_BUTTON_CORNERS) as ButtonCorner[];

/** A point from the page, or null when it isn't two finite numbers. */
function point(value: unknown): { x: number; y: number } | null {
  const { x, y } = (value ?? {}) as { x?: unknown; y?: unknown };
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Whether the desktop button is on for this Mac and build. */
export function desktopAgentOn(store: DesktopAgentStore): boolean {
  return isDesktopAgentOn(store, process.platform, build());
}

/**
 * The switch, and what the page asks of the desktop windows (ADR 0058 §5, §10, §11, §17).
 * `showWindow` brings Boundary's window forward for ⤢; `togglePanel` is what the shortcut from any
 * app does.
 */
export function registerDesktopAgentSettingHandlers(
  store: DesktopAgentStore,
  showWindow: () => void,
  togglePanel: () => void
): void {
  const shortcuts = store as unknown as ShortcutStore;
  initPanelShortcut({ api: globalShortcut, onPress: togglePanel });
  // Electron takes global shortcuts only once the app is ready.
  void app.whenReady().then(() => holdShortcut(desktopAgentOn(store), shortcuts));
  void initDesktopAgentWindows({
    store: store as unknown as DesktopAgentDeps['store'],
    isOn: () => desktopAgentOn(store),
    whenReady: () => app.whenReady(),
    screen,
    onHiddenChange: (hidden) => broadcast('desktop-agent:hidden', hidden),
  });
  handle('desktop-agent:get', () => ({
    ...desktopAgentState(store, process.platform, build()),
    hidden: isButtonHidden(),
    shortcut: storedShortcut(shortcuts),
  }));
  handleResult('desktop-agent:set-shortcut', (_event, value: unknown) => {
    if (value !== null && typeof value !== 'string') return { success: false, error: 'Expected a shortcut or none.' };
    const accelerator = value as string | null;
    const refused = accelerator === null ? null : panelShortcutError(accelerator);
    if (refused) return { success: false, error: refused };
    const result = desktopAgentOn(store) ? registerPanelShortcut(accelerator) : { ok: true };
    if (!result.ok) {
      shortcuts.set(SHORTCUT_KEY, null);
      return { success: false, error: result.error ?? 'That shortcut can’t be used.' };
    }
    shortcuts.set(SHORTCUT_KEY, accelerator);
    return { success: true };
  });
  handleResult('desktop-agent:set', (_event, on: unknown) => {
    if (typeof on !== 'boolean') return { success: false, error: 'Expected on or off.' };
    setDesktopAgentOn(store, process.platform, build(), on);
    return { success: true };
  });
  handleResult('desktop-agent:set-hidden', (_event, hidden: unknown) => {
    if (typeof hidden !== 'boolean') return { success: false, error: 'Expected shown or hidden.' };
    setButtonHidden(hidden);
    return { success: true };
  });
  handle('desktop-agent:drag', (_event, center: unknown) => {
    const at = point(center);
    if (at) dragButton(at);
  });
  handle('desktop-agent:drop', (_event, center: unknown) => {
    const at = point(center);
    return at ? dropButton(at) : null;
  });
  handle('desktop-agent:corner', (_event, corner: unknown) => {
    if (CORNER_NAMES.includes(corner as ButtonCorner)) moveButtonToCorner(corner as ButtonCorner);
  });
  handle('desktop-agent:show-window', () => showWindow());
  handle('desktop-agent:context-menu', () => {
    const window = buttonWindow() as BrowserWindow | undefined;
    Menu.buildFromTemplate(buttonMenuTemplate()).popup(window ? { window } : {});
  });
  onDesktopAgentChange((on) => {
    holdShortcut(on, shortcuts);
    broadcast('desktop-agent:changed', on);
  });
}
