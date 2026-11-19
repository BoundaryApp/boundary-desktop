import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUTTON_WINDOW,
  PANEL_WINDOW,
  adoptDesktopAgentWindow,
  closeDesktopAgentWindows,
  closeDesktopAgentWindowsForGood,
  desktopAgentOpenResponse,
  dragButton,
  dropButton,
  initDesktopAgentWindows,
  isDesktopAgentWindow,
  moveButtonToCorner,
  resetDesktopAgentWindowsForTests,
  setButtonHidden,
  type DesktopAgentWindow,
} from '../desktopAgentWindows';

const display = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };

function fakeWindow(): DesktopAgentWindow & Record<string, any> {
  const listeners: Record<string, (() => void)[]> = {};
  const win = {
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    destroyed: false,
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    showInactive: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(() => {
      win.destroyed = true;
      for (const fn of listeners.closed ?? []) fn();
    }),
    isDestroyed: () => win.destroyed,
    setBounds: vi.fn((next: typeof win.bounds) => {
      win.bounds = next;
    }),
    getBounds: () => win.bounds,
    on: vi.fn((event: string, fn: () => void) => {
      (listeners[event] ??= []).push(fn);
    }),
    emit: (event: string) => {
      for (const fn of listeners[event] ?? []) fn();
    },
  };
  return win;
}

function memoryStore() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => {
      values[key] = value;
    },
  };
}

let store: ReturnType<typeof memoryStore>;
let switchOn: boolean;
const hiddenHeard = vi.fn();

beforeEach(() => {
  resetDesktopAgentWindowsForTests();
  store = memoryStore();
  switchOn = true;
  hiddenHeard.mockClear();
  initDesktopAgentWindows({
    store,
    isOn: () => switchOn,
    whenReady: () => Promise.resolve(),
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
    },
    onHiddenChange: hiddenHeard,
  });
});

describe('desktopAgentOpenResponse (ADR 0058, How it is built)', () => {
  it('allows the two names, blank, while the switch is on', () => {
    for (const name of [BUTTON_WINDOW, PANEL_WINDOW]) {
      expect(desktopAgentOpenResponse(name, 'about:blank')?.action).toBe('allow');
    }
  });

  // Review: the page saw its windows go and asked again over the quit screen.
  it('refuses both names once quit or an update has closed the windows for good', () => {
    const button = fakeWindow();
    adoptDesktopAgentWindow(button, BUTTON_WINDOW);
    closeDesktopAgentWindowsForGood();
    expect(button.close).toHaveBeenCalled();
    expect(desktopAgentOpenResponse(BUTTON_WINDOW, 'about:blank')).toBeNull();
    expect(desktopAgentOpenResponse(PANEL_WINDOW, 'about:blank')).toBeNull();
  });

  it('refuses any other name or address, and everything while the switch is off', () => {
    expect(desktopAgentOpenResponse('other', 'about:blank')).toBeNull();
    expect(desktopAgentOpenResponse(BUTTON_WINDOW, 'https://example.com')).toBeNull();
    switchOn = false;
    expect(desktopAgentOpenResponse(BUTTON_WINDOW, 'about:blank')).toBeNull();
  });

  it('gives frameless panel windows with no parent, the button transparent and unfocusable', () => {
    const button = desktopAgentOpenResponse(BUTTON_WINDOW, 'about:blank')!.overrideBrowserWindowOptions;
    expect(button).toMatchObject({ type: 'panel', frame: false, transparent: true, focusable: false, alwaysOnTop: true, show: false, width: 60, height: 60 });
    expect(button.parent).toBeUndefined();
    const panel = desktopAgentOpenResponse(PANEL_WINDOW, 'about:blank')!.overrideBrowserWindowOptions;
    expect(panel).toMatchObject({ type: 'panel', frame: false, alwaysOnTop: true, resizable: true, width: 384, height: 520 });
    expect(panel.minWidth).toBe(384);
    expect(panel.maxHeight).toBe(720);
  });
});

describe('adoptDesktopAgentWindow', () => {
  it('floats on every Space, full-screen ones included, without hiding the Dock icon', () => {
    const win = fakeWindow();
    adoptDesktopAgentWindow(win, BUTTON_WINDOW);
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    expect(win.showInactive).toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(isDesktopAgentWindow(win)).toBe(true);
  });

  it('shows the panel with focus, next to the button', () => {
    const button = fakeWindow();
    adoptDesktopAgentWindow(button, BUTTON_WINDOW);
    const panel = fakeWindow();
    adoptDesktopAgentWindow(panel, PANEL_WINDOW);
    expect(panel.show).toHaveBeenCalled();
    expect(panel.bounds.y + panel.bounds.height).toBeLessThanOrEqual(button.bounds.y);
  });

  it('keeps a hidden button hidden', () => {
    setButtonHidden(true);
    const win = fakeWindow();
    adoptDesktopAgentWindow(win, BUTTON_WINDOW);
    expect(win.showInactive).not.toHaveBeenCalled();
  });

  it('ignores windows that are not the desktop ones', () => {
    const win = fakeWindow();
    adoptDesktopAgentWindow(win, 'other');
    expect(isDesktopAgentWindow(win)).toBe(false);
  });
});

describe('moving the button (ADR 0058 §5)', () => {
  it('follows a drag and snaps on drop, remembering the spot', () => {
    const win = fakeWindow();
    adoptDesktopAgentWindow(win, BUTTON_WINDOW);
    dragButton({ x: 500, y: 400 });
    expect(win.bounds).toEqual({ x: 470, y: 370, width: 60, height: 60 });
    const spot = dropButton({ x: 720, y: 880 });
    expect(spot.edge).toBe('bottom');
    expect(store.values.desktopAgentSpot).toEqual(spot);
    expect(win.bounds.y).toBe(25 + 875 - 16 - 60);
  });

  it('moves to a corner from the menu', () => {
    const win = fakeWindow();
    adoptDesktopAgentWindow(win, BUTTON_WINDOW);
    moveButtonToCorner('Top left');
    expect(win.bounds).toMatchObject({ x: 16, y: 25 + 16 });
    expect(store.values.desktopAgentSpot).toEqual({ displayId: 1, edge: 'top', along: 0 });
  });

  it('remembers the panel size when it is resized', () => {
    const panel = fakeWindow();
    adoptDesktopAgentWindow(panel, PANEL_WINDOW);
    panel.setBounds({ ...panel.bounds, width: 450, height: 600 });
    panel.emit('resized');
    expect(store.values.desktopAgentPanelSize).toEqual({ width: 450, height: 600 });
  });
});

describe('hiding and closing', () => {
  it('Hide button hides it and says so; showing it again shows it inactive', () => {
    const win = fakeWindow();
    adoptDesktopAgentWindow(win, BUTTON_WINDOW);
    setButtonHidden(true);
    expect(win.hide).toHaveBeenCalled();
    expect(store.values.desktopAgentHidden).toBe(true);
    expect(hiddenHeard).toHaveBeenLastCalledWith(true);
    vi.mocked(win.showInactive).mockClear();
    setButtonHidden(false);
    expect(win.showInactive).toHaveBeenCalled();
    expect(hiddenHeard).toHaveBeenLastCalledWith(false);
  });

  it('closes both windows and forgets them', () => {
    const button = fakeWindow();
    const panel = fakeWindow();
    adoptDesktopAgentWindow(button, BUTTON_WINDOW);
    adoptDesktopAgentWindow(panel, PANEL_WINDOW);
    closeDesktopAgentWindows();
    expect(button.close).toHaveBeenCalled();
    expect(panel.close).toHaveBeenCalled();
    expect(isDesktopAgentWindow(button)).toBe(false);
  });
});

// Review Focus 1: a display goes, or its size changes, while the app runs.
describe('display changes while the button shows (ADR 0058 §5)', () => {
  const side = { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } };
  let displays: (typeof display)[];
  let heard: Record<string, () => void>;

  beforeEach(async () => {
    resetDesktopAgentWindowsForTests();
    store = memoryStore();
    displays = [display, side];
    heard = {};
    await initDesktopAgentWindows({
      store,
      isOn: () => true,
      whenReady: () => Promise.resolve(),
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => display,
        getDisplayNearestPoint: () => displays.at(-1)!,
        on: (event: string, listener: () => void) => {
          heard[event] = listener;
        },
      },
      onHiddenChange: vi.fn(),
    });
  });

  it('moves the button to the main display’s bottom right when its display is unplugged', () => {
    store.set('desktopAgentSpot', { displayId: 2, edge: 'left', along: 0.5 });
    const button = fakeWindow();
    adoptDesktopAgentWindow(button, BUTTON_WINDOW);
    expect(button.bounds.x).toBeGreaterThanOrEqual(1440);
    displays = [display];
    heard['display-removed']();
    expect(button.bounds).toEqual({ x: 1440 - 16 - 60, y: 25 + 875 - 16 - 60, width: 60, height: 60 });
  });

  it('keeps the button inside a display whose size changed', () => {
    store.set('desktopAgentSpot', { displayId: 1, edge: 'right', along: 1 });
    displays = [display];
    const button = fakeWindow();
    adoptDesktopAgentWindow(button, BUTTON_WINDOW);
    display.workArea.width = 1024;
    try {
      heard['display-metrics-changed']();
      expect(button.bounds.x).toBe(1024 - 16 - 60);
    } finally {
      display.workArea.width = 1440;
    }
  });
});

// Electron's screen throws on any use before the app is ready, and init runs at module load.
describe('init before the app is ready', () => {
  it('waits for ready before listening for display changes', async () => {
    resetDesktopAgentWindowsForTests();
    let ready = false;
    let markReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const heard: string[] = [];
    const screen = {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      get on() {
        if (!ready) throw new Error("The 'screen' module can't be used before the app 'ready' event");
        return (event: string) => {
          heard.push(event);
        };
      },
    };

    const done = initDesktopAgentWindows({
      store: memoryStore(),
      isOn: () => true,
      whenReady: () => readyPromise,
      screen,
      onHiddenChange: vi.fn(),
    });
    expect(heard).toEqual([]);

    ready = true;
    markReady();
    await done;
    expect(heard).toEqual(['display-added', 'display-removed', 'display-metrics-changed']);
  });
});
