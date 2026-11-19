import React from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetPanelChatForTests, setPanelChat } from '../../agentPanel/agentPanelChat';
import { DesktopAgentPanel } from '../DesktopAgentPanel';
import {
  resetDesktopPanelForTests,
  setDesktopPanelOpen,
  setDesktopPanelTab,
  setPanelCircle,
  useDesktopPanelOpen,
} from '../desktopPanel';

const requests = vi.hoisted(() => ({ requestChatOpen: vi.fn() }));
vi.mock('../../chat/chatOpenRequests', () => requests);

/** The Agent tab's chat, standing in: a composer, and a way to call the panel's expand. */
const expandFromTab = vi.hoisted(() => ({ current: null as null | ((chatId: string | null) => void) }));
vi.mock('../../agentPanel/AgentChatPanel', () => ({
  AgentChatPanel: ({ onExpand }: { onExpand: (chatId: string | null) => void }) => {
    expandFromTab.current = onExpand;
    return <textarea aria-label="Composer" />;
  },
}));

vi.mock('../CirclesPanelTab', () => ({ CirclesPanelTab: () => <p>circles-tab</p> }));

const navigation = vi.hoisted(() => ({ openCircle: vi.fn() }));
vi.mock('../../circles/circlesNavigation', () => navigation);
const shortcuts = vi.hoisted(() => ({ dispatchAppCommand: vi.fn() }));
vi.mock('../../useAppShortcuts', async (actual) => ({
  ...(await actual<typeof import('../../useAppShortcuts')>()),
  dispatchAppCommand: shortcuts.dispatchAppCommand,
}));

let api: ReturnType<typeof stubElectronAPI>;

function OpenState() {
  return <output aria-label="open">{useDesktopPanelOpen() ? 'open' : 'closed'}</output>;
}

const show = () =>
  render(
    <>
      <DesktopAgentPanel />
      <OpenState />
    </>
  );
const isOpen = () => screen.getByRole('status', { name: 'open' }).textContent === 'open';
const composer = () => screen.getByRole('textbox', { name: 'Composer' });

beforeEach(() => {
  installElectronAPI();
  window.localStorage.clear();
  resetDesktopPanelForTests();
  resetPanelChatForTests();
  requests.requestChatOpen.mockReset();
  navigation.openCircle.mockReset();
  shortcuts.dispatchAppCommand.mockReset();
  api = stubElectronAPI({
    agents: { list: vi.fn().mockResolvedValue({ success: true, agents: [] }) },
    desktopAgent: { showWindow: vi.fn().mockResolvedValue(undefined) },
  });
  act(() => setDesktopPanelOpen(true));
});

afterEach(cleanup);

describe('DesktopAgentPanel (ADR 0058 §6, §9 to §12)', () => {
  it('opens on the Agent tab the first time and on the last tab used after', () => {
    const first = show();
    expect(screen.getByRole('tab', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Circles' }));
    first.unmount();
    resetDesktopPanelForTests();
    act(() => setDesktopPanelOpen(true));
    show();
    expect(screen.getByRole('tab', { name: 'Circles' }).getAttribute('aria-selected')).toBe('true');
  });

  it('closes on Escape', () => {
    show();
    fireEvent.keyDown(composer(), { key: 'Escape' });
    expect(isOpen()).toBe(false);
  });

  // Review: a sheet's own Escape handler registers after the panel's, so the panel must defer.
  it('leaves Escape to a sheet or menu open in it', () => {
    show();
    const sheet = document.createElement('div');
    sheet.setAttribute('role', 'dialog');
    document.body.appendChild(sheet);
    try {
      fireEvent.keyDown(composer(), { key: 'Escape' });
      expect(isOpen()).toBe(true);
    } finally {
      sheet.remove();
    }
  });

  it('leaves an Escape something inside already handled', () => {
    show();
    composer().addEventListener('keydown', (event) => event.preventDefault());
    fireEvent.keyDown(composer(), { key: 'Escape' });
    expect(isOpen()).toBe(true);
  });

  it('closes on ×', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(isOpen()).toBe(false);
  });

  it('stays open when the user clicks elsewhere or another app takes focus', () => {
    show();
    fireEvent.mouseDown(document.body);
    fireEvent.blur(window);
    expect(isOpen()).toBe(true);
  });

  it('puts focus in the composer when it opens', () => {
    show();
    expect(document.activeElement).toBe(composer());
  });

  it('refuses dropped text and files, and lets paste through', () => {
    show();
    const drop = createEvent.drop(composer(), { dataTransfer: { types: ['text/plain'], getData: () => 'from another app' } });
    fireEvent(composer(), drop);
    expect(drop.defaultPrevented).toBe(true);
    const over = createEvent.dragOver(composer(), { dataTransfer: { dropEffect: 'copy', types: ['Files'] } });
    fireEvent(composer(), over);
    expect((over as DragEvent).dataTransfer?.dropEffect).toBe('none');
    const paste = createEvent.paste(composer(), { clipboardData: { getData: () => 'pasted' } });
    fireEvent(composer(), paste);
    expect(paste.defaultPrevented).toBe(false);
  });

  it('⤢ opens the panel’s chat in Chat, shows the window and closes the panel', () => {
    act(() => setPanelChat('s-1'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Boundary’s window' }));
    expect(requests.requestChatOpen).toHaveBeenCalledWith('s-1');
    expect(api.desktopAgent.showWindow).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it('goes to Chat with no chat named when the panel has none yet', () => {
    show();
    act(() => expandFromTab.current?.(null));
    expect(requests.requestChatOpen).toHaveBeenCalledWith(null);
    expect(api.desktopAgent.showWindow).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it('draws the Circles tab when it is chosen', () => {
    show();
    fireEvent.click(screen.getByRole('tab', { name: 'Circles' }));
    expect(screen.getByText('circles-tab')).toBeTruthy();
  });

  it('⤢ on the Circles tab opens the panel’s Circle in the Circles screen', () => {
    act(() => {
      setDesktopPanelTab('circles');
      setPanelCircle('k1');
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Boundary’s window' }));
    expect(navigation.openCircle).toHaveBeenCalledWith('k1');
    expect(requests.requestChatOpen).not.toHaveBeenCalled();
    expect(api.desktopAgent.showWindow).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it('⤢ on the Circles list goes to the Circles screen', () => {
    act(() => setDesktopPanelTab('circles'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Boundary’s window' }));
    expect(shortcuts.dispatchAppCommand).toHaveBeenCalledWith('go-circles');
    expect(navigation.openCircle).not.toHaveBeenCalled();
  });
});
