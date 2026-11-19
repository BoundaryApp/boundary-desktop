import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { DesktopAgentButton } from '../DesktopAgentButton';
import { resetDesktopPanelForTests, setDesktopPanelOpen, setDesktopPanelTab, useDesktopPanelOpen } from '../desktopPanel';

const unread = vi.hoisted(() => ({ value: { total: 0, mentioned: false } }));
vi.mock('../../circles/useCirclesUnread', () => ({ useCirclesUnread: () => unread.value }));

const turns = vi.hoisted(() => ({ value: [] as { requestId: string; agentSlug: string | null }[] }));
vi.mock('../../chat/runningTurns', () => ({ useRunningTurns: () => turns.value }));

let api: ReturnType<typeof stubElectronAPI>;

function PanelState() {
  return <output aria-label="panel">{useDesktopPanelOpen() ? 'open' : 'closed'}</output>;
}

const show = () =>
  render(
    <>
      <DesktopAgentButton />
      <PanelState />
    </>
  );
const button = () => screen.getByRole('button', { name: /^Ask / });
const panel = () => screen.getByRole('status', { name: 'panel' }).textContent;

beforeEach(() => {
  installElectronAPI();
  window.localStorage.clear();
  resetDesktopPanelForTests();
  unread.value = { total: 0, mentioned: false };
  turns.value = [];
  api = stubElectronAPI({
    agents: { list: vi.fn().mockResolvedValue({ success: true, agents: [] }) },
    desktopAgent: {
      drag: vi.fn().mockResolvedValue(undefined),
      drop: vi.fn().mockResolvedValue(null),
      contextMenu: vi.fn().mockResolvedValue(undefined),
    },
  });
});

afterEach(cleanup);

describe('DesktopAgentButton (ADR 0058 §3 to §5)', () => {
  it('is labelled Ask name and toggles the panel on click', () => {
    show();
    expect(button().getAttribute('aria-label')).toMatch(/^Ask /);
    fireEvent.click(button());
    expect(panel()).toBe('open');
    fireEvent.click(button());
    expect(panel()).toBe('closed');
  });

  it('treats a move under 4px as a click', () => {
    show();
    fireEvent.pointerDown(button(), { button: 0, pointerId: 1, clientX: 30, clientY: 30, screenX: 1000, screenY: 800 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 32, clientY: 31, screenX: 1002, screenY: 801 });
    fireEvent.pointerUp(button(), { pointerId: 1, clientX: 32, clientY: 31, screenX: 1002, screenY: 801 });
    fireEvent.click(button());
    expect(api.desktopAgent.drag).not.toHaveBeenCalled();
    expect(panel()).toBe('open');
  });

  it('sends the button centre in screen coordinates while dragged, drops it there, and swallows the click', () => {
    show();
    // Grabbed 10px left and 5px above its centre.
    fireEvent.pointerDown(button(), { button: 0, pointerId: 1, clientX: 20, clientY: 25, screenX: 1000, screenY: 800 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 60, clientY: 25, screenX: 1040, screenY: 800 });
    expect(api.desktopAgent.drag).toHaveBeenLastCalledWith({ x: 1050, y: 805 });
    fireEvent.pointerUp(button(), { pointerId: 1, clientX: 70, clientY: 25, screenX: 1050, screenY: 800 });
    expect(api.desktopAgent.drop).toHaveBeenCalledWith({ x: 1060, y: 805 });
    fireEvent.click(button());
    expect(panel()).toBe('closed');
  });

  it('asks main for its menu: the four corners and Hide button', () => {
    show();
    fireEvent.contextMenu(button());
    expect(api.desktopAgent.contextMenu).toHaveBeenCalledTimes(1);
  });

  it('shows the working mark while a built-in agent turn runs', () => {
    turns.value = [{ requestId: 'r1', agentSlug: null }];
    show();
    expect(screen.getByRole('img', { name: /is working$/ })).toBeTruthy();
  });

  it('shows a reply dot when a turn ends while the panel is closed, and clears it when the panel opens', () => {
    turns.value = [{ requestId: 'r1', agentSlug: null }];
    const { rerender } = show();
    turns.value = [];
    rerender(
      <>
        <DesktopAgentButton />
        <PanelState />
      </>
    );
    expect(screen.getByRole('img', { name: / replied$/ })).toBeTruthy();
    act(() => setDesktopPanelOpen(true));
    expect(screen.queryByRole('img', { name: / replied$/ })).toBeNull();
  });

  it('keeps the reply dot while the panel shows the Circles tab', () => {
    turns.value = [{ requestId: 'r1', agentSlug: null }];
    const { rerender } = show();
    turns.value = [];
    rerender(
      <>
        <DesktopAgentButton />
        <PanelState />
      </>
    );
    act(() => {
      setDesktopPanelTab('circles');
      setDesktopPanelOpen(true);
    });
    expect(screen.getByRole('img', { name: / replied$/ })).toBeTruthy();
    act(() => setDesktopPanelTab('agent'));
    expect(screen.queryByRole('img', { name: / replied$/ })).toBeNull();
  });

  it('shows the Circle unread count with the mention mark', () => {
    unread.value = { total: 4, mentioned: true };
    show();
    expect(screen.getByRole('img', { name: '4 unread in Circles, mentions you' })).toBeTruthy();
  });

  it('shows no count with nothing unread', () => {
    show();
    expect(screen.queryByRole('img', { name: /unread in Circles/ })).toBeNull();
  });
});
