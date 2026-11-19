import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ notifications: [] as Array<{ emit(event: string): void }> }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeNotification extends Emitter {
    static isSupported = () => true;
    show = vi.fn();
    constructor() {
      super();
      h.notifications.push(this);
    }
  }
  return {
    app: { isReady: () => true, focus: vi.fn() },
    BrowserWindow: { getAllWindows: (): unknown[] => [] },
    Notification: FakeNotification,
  };
});
vi.mock('../../persistDebugLog', () => ({ persistDebugLog: vi.fn(), serializeError: (e: unknown) => ({ e }) }));

import { setMainWindowFactory } from '../windows';
import { showWindowNotification } from '../notifications';

function fakeWindow(loading: boolean) {
  const webContents = Object.assign(new EventEmitter(), { isLoading: () => loading });
  return {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('showWindowNotification', () => {
  beforeEach(() => {
    h.notifications.length = 0;
    global.mainWindow = undefined;
  });
  afterEach(() => {
    global.mainWindow = undefined;
    setMainWindowFactory(async () => undefined);
  });

  it('re-creates a closed main window on click and passes it to onClick once loaded', async () => {
    const created = fakeWindow(true);
    const factory = vi.fn(async () => {
      global.mainWindow = created as never;
    });
    setMainWindowFactory(factory);
    const onClick = vi.fn();

    showWindowNotification({ title: 'New message', body: 'Hi' }, onClick);
    h.notifications[0].emit('click');
    await flush();

    expect(factory).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
    created.webContents.emit('did-finish-load');
    expect(onClick).toHaveBeenCalledWith(created);
  });

  it('brings an open main window forward and passes it to onClick', async () => {
    const open = fakeWindow(false);
    global.mainWindow = open as never;
    const factory = vi.fn(async () => undefined);
    setMainWindowFactory(factory);
    const onClick = vi.fn();

    showWindowNotification({ title: 'New message', body: 'Hi' }, onClick);
    h.notifications[0].emit('click');
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(open.show).toHaveBeenCalled();
    expect(open.focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith(open);
  });
});
