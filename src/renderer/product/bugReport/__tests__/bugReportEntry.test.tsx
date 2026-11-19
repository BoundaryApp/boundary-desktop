import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot } from '../../../../shared/assistantStackLifecycle';
import { ariaShortcut, formatShortcut, type AppCommand } from '../../../../shared/appCommands';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { isReportShortcut, openBugReport } from '../bugReportEvents';
import { isMacPlatform } from '../../useAppShortcuts';
import { ProductApp, reportScreenName } from '../../ProductApp';

const useSetup = vi.fn();
const useAssistantStackLifecycle = vi.fn();

vi.mock('../../../setup/SetupContext', () => ({ useSetup: () => useSetup() }));
vi.mock('../../assistantStack', () => ({
  useAssistantStackLifecycle: () => useAssistantStackLifecycle(),
  useAssistantStackStatus: () => (useSetup() as { assistantStackStatus?: unknown }).assistantStackStatus ?? null,
}));
vi.mock('../../../setup/SetupFlowShell', () => ({ SetupFlowShell: () => <div>setup-flow</div> }));
vi.mock('../../ProductReadyShell', () => ({ ProductReadyShell: () => <div>chat-workbench</div> }));
vi.mock('../../AssistantStackStartingScreen', () => ({
  AssistantStackStartingScreen: () => <div>starting-screen</div>,
}));
vi.mock('../../AssistantStackQuitOverlay', () => ({ AssistantStackQuitOverlay: (): null => null }));

function mountInSetup() {
  let menu: ((command: AppCommand) => void) | undefined;
  stubElectronAPI({
    appMenu: {
      onCommand: vi.fn((callback: (command: AppCommand) => void) => {
        menu = callback;
        return (): void => undefined;
      }),
    },
    bugReport: { collect: vi.fn(() => new Promise(() => undefined)) },
  });
  useSetup.mockReturnValue({ allComplete: false, assistantStackStatus: null });
  useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('idle'));
  render(<ProductApp />);
  return { menu: (command: AppCommand) => act(() => menu?.(command)) };
}

/** ⇧⌘B, or Ctrl+Shift+B where the test DOM's user agent isn't a Mac's. */
const reportKeys = (key: string) =>
  isMacPlatform() ? { key, metaKey: true, shiftKey: true } : { key, ctrlKey: true, shiftKey: true };

afterEach(() => {
  vi.clearAllMocks();
});

describe('opening the report sheet', () => {
  it('opens from Help › Report a Bug… during setup, over an inert app', () => {
    const { menu } = mountInSetup();
    menu('go-chat');
    expect(screen.queryByRole('dialog')).toBeNull();
    menu('report-bug');
    expect(screen.getByRole('dialog', { name: 'Report a bug' })).toBeTruthy();
    expect(screen.getByText('setup-flow').closest('[inert]')).toBeTruthy();
  });

  it('opens from the shortcut and from the rail, and closes again', () => {
    mountInSetup();
    fireEvent.keyDown(window, reportKeys('B'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('setup-flow').closest('[inert]')).toBeNull();
    act(() => openBugReport());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens during start-up', () => {
    mountInSetup();
    useSetup.mockReturnValue({ allComplete: true, assistantStackStatus: { setupComplete: true, ready: false } });
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('starting'));
    cleanup();
    render(<ProductApp />);
    expect(screen.getByText('starting-screen')).toBeTruthy();
    fireEvent.keyDown(window, reportKeys('b'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('the shortcut', () => {
  it('matches ⇧⌘B only', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(isReportShortcut(key({ key: 'b', metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isReportShortcut(key({ key: 'b', metaKey: true }), true)).toBe(false);
    expect(isReportShortcut(key({ key: 'b', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isReportShortcut(key({ key: 'b', ctrlKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('reads ⇧⌘B on macOS and Ctrl+Shift+B elsewhere', () => {
    expect(formatShortcut('report-bug', true)).toBe('⇧⌘B');
    expect(formatShortcut('report-bug', false)).toBe('Ctrl+Shift+B');
    expect(formatShortcut('new-chat', true)).toBe('⌘N');
    expect(formatShortcut('new-chat', false)).toBe('Ctrl+N');
    expect(ariaShortcut('report-bug', true)).toBe('Meta+Shift+B');
    expect(ariaShortcut('go-chat', false)).toBe('Control+1');
  });
});

describe('reportScreenName', () => {
  it('names product screens and hides any other', () => {
    expect(reportScreenName('ready:chat')).toBe('Chat');
    expect(reportScreenName('setup')).toBe('Setup');
    expect(reportScreenName('ready:experiment:anything')).toBe('Other');
  });
});
