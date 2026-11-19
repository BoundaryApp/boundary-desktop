import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_BUTTON_WINDOW, DESKTOP_PANEL_WINDOW } from '../../../../shared/types/desktopAgent';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { useOwnerDocument } from '../../../components/ui/ownerDocument';
import { DesktopAgentHost } from '../DesktopAgentHost';
import { adoptStyles } from '../childDocument';
import { dispatchAppCommand, isMacPlatform } from '../../useAppShortcuts';
import { resetDesktopPanelForTests, setDesktopPanelOpen, toggleDesktopPanel } from '../desktopPanel';

/** What window.open returned, by name, as separate windows and realms like Chromium's. */
let opened: Record<string, HappyWindow>;
let openSpy: ReturnType<typeof vi.spyOn>;

function stubSwitch(on: boolean) {
  stubElectronAPI({
    desktopAgent: {
      get: vi.fn().mockResolvedValue({ available: true, on, hidden: false }),
      onChanged: vi.fn((): (() => void) => () => undefined),
      onHiddenChanged: vi.fn((): (() => void) => () => undefined),
    },
  });
}

/** Shows which document it was drawn in. */
function WhereAmI({ label }: { label: string }) {
  const doc = useOwnerDocument();
  return <span data-label={label}>{doc === document ? 'page' : 'child'}</span>;
}

const settle = () => act(async () => undefined);

beforeEach(() => {
  installElectronAPI();
  resetDesktopPanelForTests();
  opened = {};
  openSpy = vi.spyOn(window, 'open').mockImplementation(((_url?: string | URL, name?: string) => {
    const child = new HappyWindow();
    opened[name ?? ''] = child;
    return child as unknown as Window;
  }) as typeof window.open);
});

afterEach(async () => {
  cleanup();
  openSpy.mockRestore();
  for (const child of Object.values(opened)) await child.happyDOM.close();
  document.head.querySelectorAll('[data-test-style]').forEach((node) => node.remove());
});

const host = () => render(<DesktopAgentHost button={<WhereAmI label="button" />} panel={<WhereAmI label="panel" />} />);
const shown = (name: string, label: string) =>
  (opened[name]?.document as unknown as Document | undefined)?.querySelector(`[data-label="${label}"]`)?.textContent ?? null;

describe('DesktopAgentHost (ADR 0058, How it is built)', () => {
  it('opens the button window blank and draws the button in it', async () => {
    stubSwitch(true);
    host();
    await settle();
    expect(openSpy).toHaveBeenCalledWith('about:blank', DESKTOP_BUTTON_WINDOW, '');
    expect(shown(DESKTOP_BUTTON_WINDOW, 'button')).toBe('child');
    expect(opened[DESKTOP_PANEL_WINDOW]).toBeUndefined();
  });

  it('opens nothing while the switch is off', async () => {
    stubSwitch(false);
    host();
    await settle();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the panel on toggle and closes it on the next', async () => {
    stubSwitch(true);
    host();
    await settle();
    act(() => toggleDesktopPanel());
    await settle();
    expect(shown(DESKTOP_PANEL_WINDOW, 'panel')).toBe('child');
    const panel = opened[DESKTOP_PANEL_WINDOW];
    const close = vi.spyOn(panel, 'close');
    act(() => toggleDesktopPanel());
    await settle();
    expect(close).toHaveBeenCalled();
  });

  it('reopens the button when its window goes away by itself', async () => {
    stubSwitch(true);
    host();
    await settle();
    const first = opened[DESKTOP_BUTTON_WINDOW];
    act(() => {
      first.dispatchEvent(new first.Event('pagehide'));
    });
    await settle();
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(opened[DESKTOP_BUTTON_WINDOW]).not.toBe(first);
  });

  it('marks the panel closed when its window goes away by itself', async () => {
    stubSwitch(true);
    host();
    await settle();
    act(() => setDesktopPanelOpen(true));
    await settle();
    const panel = opened[DESKTOP_PANEL_WINDOW];
    act(() => {
      panel.dispatchEvent(new panel.Event('pagehide'));
    });
    await settle();
    act(() => toggleDesktopPanel());
    await settle();
    // Toggling after the window went opens it again rather than closing a gone one.
    expect(openSpy).toHaveBeenCalledWith('about:blank', DESKTOP_PANEL_WINDOW, '');
    expect(opened[DESKTOP_PANEL_WINDOW]).not.toBe(panel);
  });

  it('opens and closes the panel on ⌘J, whatever screen the app shows (§11)', async () => {
    stubSwitch(true);
    host();
    await settle();
    act(() => dispatchAppCommand('toggle-agent'));
    await settle();
    expect(shown(DESKTOP_PANEL_WINDOW, 'panel')).toBe('child');
    const close = vi.spyOn(opened[DESKTOP_PANEL_WINDOW], 'close');
    act(() => dispatchAppCommand('toggle-agent'));
    await settle();
    expect(close).toHaveBeenCalled();
  });

  it('turns ⌘J pressed in the panel into the toggle, and leaves the app’s other keys alone', async () => {
    stubSwitch(true);
    host();
    await settle();
    act(() => setDesktopPanelOpen(true));
    await settle();
    const panel = opened[DESKTOP_PANEL_WINDOW];
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener('boundary:command', listener);
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
    act(() => {
      panel.document.dispatchEvent(new panel.KeyboardEvent('keydown', { key: 'n', ...mod, bubbles: true }));
      panel.document.dispatchEvent(new panel.KeyboardEvent('keydown', { key: 'j', ...mod, bubbles: true }));
    });
    window.removeEventListener('boundary:command', listener);
    expect(heard).toEqual(['toggle-agent']);
  });

  it('closes both windows when unmounted', async () => {
    stubSwitch(true);
    const { unmount } = host();
    await settle();
    const close = vi.spyOn(opened[DESKTOP_BUTTON_WINDOW], 'close');
    unmount();
    expect(close).toHaveBeenCalled();
  });
});

describe('adoptStyles', () => {
  it('copies the page styles and theme, and follows ones added later', async () => {
    const child = new HappyWindow();
    opened.styles = child;
    const doc = child.document as unknown as Document;
    const first = document.createElement('style');
    first.dataset.testStyle = 'a';
    first.textContent = '.a { color: red }';
    document.head.appendChild(first);
    document.documentElement.dataset.theme = 'dark';
    const stop = adoptStyles(doc);
    expect(doc.head.querySelector('[data-test-style="a"]')?.textContent).toBe('.a { color: red }');
    expect(doc.documentElement.dataset.theme).toBe('dark');
    const later = document.createElement('style');
    later.dataset.testStyle = 'b';
    document.head.appendChild(later);
    document.documentElement.dataset.theme = 'light';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(doc.head.querySelector('[data-test-style="b"]')).not.toBeNull();
    expect(doc.documentElement.dataset.theme).toBe('light');
    stop();
  });
});
