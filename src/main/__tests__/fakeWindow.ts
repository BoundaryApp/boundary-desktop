import { vi } from 'vitest';

/**
 * A stand-in for Electron's BrowserWindow and its webContents, for tests that drive the main
 * window through the listeners main registers on it. Load it from a `vi.mock('electron')` factory
 * with `await import('./fakeWindow')`.
 */

type Handler = (...args: any[]) => any;

export class FakeEmitter {
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

export class FakeWebContents extends FakeEmitter {
  send = vi.fn();
  setBackgroundThrottling = vi.fn();
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
  session = {
    webRequest: { onHeadersReceived: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  openDevTools = vi.fn();
}

export class FakeBrowserWindow extends FakeEmitter {
  /** Every window made since the last `reset()`, in order. */
  static made: FakeBrowserWindow[] = [];
  static reset() {
    FakeBrowserWindow.made = [];
  }
  static getAllWindows() {
    return FakeBrowserWindow.made.filter((w) => !w.destroyed);
  }
  options: any;
  destroyed = false;
  webContents = new FakeWebContents();
  loadURL = vi.fn(async (_url: string) => undefined);
  loadFile = vi.fn(async (_path: string) => undefined);
  visible = true;
  show = vi.fn(() => {
    this.visible = true;
    this.emit('show');
  });
  hide = vi.fn(() => {
    this.visible = false;
    this.emit('hide');
  });
  isVisible() {
    return this.visible;
  }
  fullScreen = false;
  isFullScreen() {
    return this.fullScreen;
  }
  setFullScreen = vi.fn((on: boolean) => {
    this.fullScreen = on;
  });
  bounds = { x: 10, y: 10, width: 800, height: 600 };
  getBounds() {
    return this.bounds;
  }
  focus = vi.fn();
  restore = vi.fn();
  setBackgroundColor = vi.fn();
  constructor(options: any) {
    super();
    this.options = options;
    FakeBrowserWindow.made.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
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

/** One display at the origin. */
export const fakeDisplay = {
  id: 42,
  workArea: { x: 0, y: 0, width: 2000, height: 1400 },
  workAreaSize: { width: 2000, height: 1400 },
};

/** A child window the page opened (the desktop button or panel). */
export function fakeChildWindow() {
  const contents = {
    openHandler: null as null | ((details: { url: string }) => unknown),
    listeners: {} as Record<string, (...args: any[]) => void>,
    setWindowOpenHandler: vi.fn((fn: (details: { url: string }) => unknown) => {
      contents.openHandler = fn;
    }),
    on: vi.fn((event: string, fn: (...args: any[]) => void) => {
      contents.listeners[event] = fn;
    }),
  };
  return {
    webContents: contents,
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    showInactive: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    setBounds: vi.fn(),
    getBounds: () => ({ x: 0, y: 0, width: 60, height: 60 }),
    on: vi.fn(),
  };
}
