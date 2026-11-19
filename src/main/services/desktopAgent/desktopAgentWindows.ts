import {
  AGENT_BUTTON_CORNERS,
  DESKTOP_BUTTON_WINDOW,
  DESKTOP_PANEL_WINDOW,
  type AgentButtonCorner,
} from '../../../shared/types/desktopAgent';
import { BUTTON_SIZE, nearestScreenSpot, panelBounds, placeButton, type Rect, type ScreenSpot, type SpotDisplay } from './screenSpot';

/**
 * The desktop button's and panel's windows (ADR 0058 §2, §6). The app's page opens them with
 * `window.open('about:blank', name)` and draws into them; main gives them their window options,
 * keeps them floating on every Space, and places them.
 */
export const BUTTON_WINDOW = DESKTOP_BUTTON_WINDOW;
export const PANEL_WINDOW = DESKTOP_PANEL_WINDOW;

const PANEL_DEFAULT = { width: 384, height: 520 };

export type ButtonCorner = AgentButtonCorner;
const CORNERS = AGENT_BUTTON_CORNERS;

/** The part of a BrowserWindow this module uses. */
export interface DesktopAgentWindow {
  setAlwaysOnTop(flag: boolean, level: 'floating'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options: { visibleOnFullScreen: boolean; skipTransformProcessType: boolean }): void;
  showInactive(): void;
  show(): void;
  hide(): void;
  close(): void;
  isDestroyed(): boolean;
  setBounds(bounds: Rect): void;
  getBounds(): Rect;
  on(event: 'closed' | 'resized', listener: () => void): unknown;
}

interface DesktopAgentStore {
  get(key: 'desktopAgentSpot' | 'desktopAgentPanelSize' | 'desktopAgentHidden'): unknown;
  set(key: 'desktopAgentSpot' | 'desktopAgentPanelSize' | 'desktopAgentHidden', value: unknown): void;
}

interface Screen {
  getAllDisplays(): SpotDisplay[];
  getPrimaryDisplay(): SpotDisplay;
  getDisplayNearestPoint(point: { x: number; y: number }): SpotDisplay;
  on?(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): unknown;
}

export interface DesktopAgentDeps {
  store: DesktopAgentStore;
  isOn: () => boolean;
  /** Electron's screen throws on any use before the app is ready, and init runs at module load. */
  whenReady: () => Promise<unknown>;
  screen: Screen;
  /** **Hide button** or **Show Agent Button** changed whether the button shows. */
  onHiddenChange: (hidden: boolean) => void;
}

let deps: DesktopAgentDeps | null = null;
const open = new Map<string, DesktopAgentWindow>();
/** Quit or an update install has begun: the page may ask for its windows again, and gets none. */
let gone = false;

/** Resolves once the display listeners are on, after the app is ready. */
export async function initDesktopAgentWindows(next: DesktopAgentDeps): Promise<void> {
  deps = next;
  await next.whenReady();
  // A display unplugged, added or resized while the app runs: place both windows again (§5).
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
    next.screen.on?.(event, placeAgain);
  }
}

function placeAgain(): void {
  const button = open.get(BUTTON_WINDOW);
  if (button && !button.isDestroyed()) button.setBounds(buttonBounds());
  const panel = open.get(PANEL_WINDOW);
  if (panel && !panel.isDestroyed()) panel.setBounds(panelBoundsNow());
}

function storedSpot(): ScreenSpot | null {
  const value = deps?.store.get('desktopAgentSpot') as Partial<ScreenSpot> | undefined;
  if (!value || typeof value.displayId !== 'number' || typeof value.along !== 'number') return null;
  if (!['top', 'right', 'bottom', 'left'].includes(value.edge as string)) return null;
  return value as ScreenSpot;
}

function storedPanelSize(): { width: number; height: number } {
  const value = deps?.store.get('desktopAgentPanelSize') as { width?: unknown; height?: unknown } | undefined;
  return typeof value?.width === 'number' && typeof value.height === 'number'
    ? { width: value.width, height: value.height }
    : PANEL_DEFAULT;
}

export function isButtonHidden(): boolean {
  return deps?.store.get('desktopAgentHidden') === true;
}

function buttonBounds(): Rect {
  if (!deps) return { x: 0, y: 0, width: BUTTON_SIZE, height: BUTTON_SIZE };
  return placeButton(storedSpot(), deps.screen.getAllDisplays(), deps.screen.getPrimaryDisplay().id);
}

function panelBoundsNow(): Rect {
  const button = open.get(BUTTON_WINDOW)?.getBounds() ?? buttonBounds();
  const center = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
  const area = deps?.screen.getDisplayNearestPoint(center).workArea ?? { x: 0, y: 0, width: 1280, height: 800 };
  return panelBounds(button, area, storedPanelSize());
}

/** What `setWindowOpenHandler` returns for a desktop window, or null when it isn't one. */
export function desktopAgentOpenResponse(
  frameName: string,
  url: string
): { action: 'allow'; overrideBrowserWindowOptions: Record<string, unknown> } | null {
  if (gone || !deps?.isOn() || url !== 'about:blank') return null;
  const shared = {
    type: 'panel',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: { backgroundThrottling: false },
  };
  if (frameName === BUTTON_WINDOW) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { ...shared, ...buttonBounds(), transparent: true, focusable: false, resizable: false, hasShadow: false },
    };
  }
  if (frameName === PANEL_WINDOW) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...shared,
        ...panelBoundsNow(),
        resizable: true,
        hasShadow: true,
        minWidth: 384,
        minHeight: 520,
        maxWidth: 480,
        maxHeight: 720,
      },
    };
  }
  return null;
}

/** Take a window Electron made for a desktop name: float it, place it and show it. */
export function adoptDesktopAgentWindow(win: DesktopAgentWindow, frameName: string): void {
  if (frameName !== BUTTON_WINDOW && frameName !== PANEL_WINDOW) return;
  open.get(frameName)?.close();
  open.set(frameName, win);
  win.on('closed', () => {
    if (open.get(frameName) === win) open.delete(frameName);
  });
  win.setAlwaysOnTop(true, 'floating');
  // Without skipTransformProcessType, macOS turns the app into one with no Dock icon.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  if (frameName === BUTTON_WINDOW) {
    win.setBounds(buttonBounds());
    // The button never takes focus (§3).
    if (!isButtonHidden()) win.showInactive();
    return;
  }
  win.setBounds(panelBoundsNow());
  win.on('resized', () => {
    const { width, height } = win.getBounds();
    deps?.store.set('desktopAgentPanelSize', { width, height });
  });
  win.show();
}

export function isDesktopAgentWindow(win: unknown): boolean {
  return [...open.values()].includes(win as DesktopAgentWindow);
}

/** Close both windows: when the switch goes off and when the page that drew them reloads. */
export function closeDesktopAgentWindows(): void {
  for (const win of [...open.values()]) {
    if (!win.isDestroyed()) win.close();
  }
  open.clear();
}

/** Keep the button under the pointer while it is dragged; `center` is in screen coordinates. */
export function dragButton(center: { x: number; y: number }): void {
  const win = open.get(BUTTON_WINDOW);
  if (!win || win.isDestroyed()) return;
  win.setBounds({ x: Math.round(center.x - BUTTON_SIZE / 2), y: Math.round(center.y - BUTTON_SIZE / 2), width: BUTTON_SIZE, height: BUTTON_SIZE });
}

function placeAt(spot: ScreenSpot): void {
  deps?.store.set('desktopAgentSpot', spot);
  const win = open.get(BUTTON_WINDOW);
  if (win && !win.isDestroyed()) win.setBounds(buttonBounds());
}

/** Snap a dropped button to the nearest edge of its display and remember the spot. */
export function dropButton(center: { x: number; y: number }): ScreenSpot {
  const display = deps!.screen.getDisplayNearestPoint(center);
  const spot = nearestScreenSpot(center, display);
  placeAt(spot);
  return spot;
}

/** Move the button to a corner of the display it is on. */
export function moveButtonToCorner(corner: ButtonCorner): void {
  if (!deps) return;
  const at = open.get(BUTTON_WINDOW)?.getBounds() ?? buttonBounds();
  const display = deps.screen.getDisplayNearestPoint({ x: at.x + at.width / 2, y: at.y + at.height / 2 });
  placeAt({ displayId: display.id, ...CORNERS[corner] });
}

/** **Hide button**, or **Show Agent Button** and the Settings switch bringing it back (§5). */
export function setButtonHidden(hidden: boolean): void {
  if (!deps) return;
  deps.store.set('desktopAgentHidden', hidden);
  const win = open.get(BUTTON_WINDOW);
  if (win && !win.isDestroyed()) {
    if (hidden) win.hide();
    else win.showInactive();
  }
  deps.onHiddenChange(hidden);
}

/** The button's menu (§5): the four corners, then **Hide button**. */
export function buttonMenuTemplate(): ({ label: string; click: () => void } | { type: 'separator' })[] {
  return [
    ...(Object.keys(CORNERS) as ButtonCorner[]).map((corner) => ({ label: corner, click: () => moveButtonToCorner(corner) })),
    { type: 'separator' as const },
    { label: 'Hide button', click: () => setButtonHidden(true) },
  ];
}

/** The button's window, for its menu to open over. */
export function buttonWindow(): DesktopAgentWindow | undefined {
  const win = open.get(BUTTON_WINDOW);
  return win && !win.isDestroyed() ? win : undefined;
}

/** Close both windows before the quit screen or an update install, and refuse them after. */
export function closeDesktopAgentWindowsForGood(): void {
  gone = true;
  closeDesktopAgentWindows();
}

export function resetDesktopAgentWindowsForTests(): void {
  deps = null;
  gone = false;
  open.clear();
}
