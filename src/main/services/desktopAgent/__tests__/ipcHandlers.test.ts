import Store from 'electron-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeChildWindow, fakeDisplay } from '../../../__tests__/fakeWindow';

type Handler = (...args: any[]) => any;

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  menuTemplate: [] as { label?: string; click?: () => void }[],
}));

vi.mock('electron', async () => {
  const { fakeDisplay } = await import('../../../__tests__/fakeWindow');
  return {
    app: { isPackaged: false, whenReady: () => new Promise<void>(() => undefined) },
    BrowserWindow: { getAllWindows: (): unknown[] => [] },
    ipcMain: {
      handle: vi.fn((channel: string, fn: Handler) => {
        h.handlers[channel] = fn;
      }),
    },
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    Menu: {
      buildFromTemplate: vi.fn((template: typeof h.menuTemplate) => {
        h.menuTemplate = template;
        return { popup: vi.fn() };
      }),
    },
    screen: {
      getPrimaryDisplay: () => fakeDisplay,
      getAllDisplays: () => [fakeDisplay],
      getDisplayNearestPoint: () => fakeDisplay,
    },
  };
});

const config = new Store<Record<string, unknown>>({ name: 'desktop-agent-ipc-test' });
const showWindow = vi.fn();

/** Fresh handlers with the switch on and the button window open. */
async function registerWithButton() {
  vi.resetModules();
  config.set('desktopAgentButton', true);
  const { registerDesktopAgentSettingHandlers } = await import('../ipcHandlers');
  const { adoptDesktopAgentWindow } = await import('../desktopAgentWindows');
  registerDesktopAgentSettingHandlers(config as never, showWindow, vi.fn());
  const button = fakeChildWindow();
  adoptDesktopAgentWindow(button as never, 'boundary-agent-button');
  return button;
}

const realPlatform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers = {};
  config.clear();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  return () => Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('desktop agent IPC (ADR 0058)', () => {
  it('answers the page: drag, drop, corner, hide and show the window', async () => {
    const button = await registerWithButton();
    await h.handlers['desktop-agent:drag']({}, { x: 500, y: 400 });
    expect(button.setBounds).toHaveBeenLastCalledWith({ x: 470, y: 370, width: 60, height: 60 });
    const spot = await h.handlers['desktop-agent:drop']({}, { x: 1000, y: 1390 });
    expect(spot).toMatchObject({ displayId: fakeDisplay.id, edge: 'bottom' });
    await h.handlers['desktop-agent:corner']({}, 'Top left');
    expect(config.get('desktopAgentSpot')).toEqual({ displayId: fakeDisplay.id, edge: 'top', along: 0 });
    await h.handlers['desktop-agent:set-hidden']({}, true);
    expect(button.hide).toHaveBeenCalled();
    expect(await h.handlers['desktop-agent:get']({})).toMatchObject({ hidden: true });
    await h.handlers['desktop-agent:show-window']({});
    expect(showWindow).toHaveBeenCalled();
  });

  it('pops the button menu: the four corners and Hide button', async () => {
    await registerWithButton();
    await h.handlers['desktop-agent:context-menu']({});
    expect(h.menuTemplate.filter((item) => item.label).map((item) => item.label)).toEqual([
      'Bottom right',
      'Bottom left',
      'Top right',
      'Top left',
      'Hide button',
    ]);
    h.menuTemplate.find((item) => item.label === 'Top left')!.click!();
    expect(config.get('desktopAgentSpot')).toEqual({ displayId: fakeDisplay.id, edge: 'top', along: 0 });
    h.menuTemplate.find((item) => item.label === 'Hide button')!.click!();
    expect(config.get('desktopAgentHidden')).toBe(true);
  });

  it('refuses malformed drag and corner input', async () => {
    await registerWithButton();
    await h.handlers['desktop-agent:corner']({}, 'Middle');
    expect(config.get('desktopAgentSpot')).toBeUndefined();
    expect(await h.handlers['desktop-agent:drop']({}, { x: 'a' })).toBeNull();
    expect(await h.handlers['desktop-agent:drag']({}, null)).toBeUndefined();
  });
});
