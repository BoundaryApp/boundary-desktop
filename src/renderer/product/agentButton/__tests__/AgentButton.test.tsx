import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesRunningTurn } from '../../../../shared/types/hermesChat';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { setRunningTurnsForTests } from '../../chat/runningTurns';
import { dispatchAppCommand } from '../../useAppShortcuts';
import { AgentButton } from '../AgentButton';
import { flushMenu } from '../../../__tests__/openMenu';
import { resetAgentButtonSpotForTests } from '../agentButtonSpot';

stubElectronAPI({
  agents: {
    list: vi.fn(async () => ({
      success: true,
      agents: [{ slug: 'assistant', displayName: 'Marlow', handle: 'marlow' }],
      standingDmByAgent: {},
    })),
  },
});

const turn = (requestId: string, agentSlug: string | null = 'assistant'): HermesRunningTurn => ({
  requestId,
  sessionIds: [`s-${requestId}`],
  agentSlug,
  startedAt: '2026-11-11T09:00:00Z',
});

/** The content area: 1000×700 from the window's top left. */
function mount(hidden = false, onOpen = vi.fn()) {
  const utils = render(
    <div data-testid="area" style={{ position: 'relative' }}>
      <AgentButton hidden={hidden} onOpen={onOpen} />
    </div>
  );
  vi.spyOn(screen.getByTestId('area'), 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 700,
    right: 1000,
    bottom: 700,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return { ...utils, onOpen };
}

const button = () => screen.getByRole('button', { name: 'Ask Marlow' });
const stored = () => JSON.parse(window.localStorage.getItem('boundary:agent-button') ?? 'null');

describe('the agent button', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAgentButtonSpotForTests();
    setRunningTurnsForTests([]);
  });
  afterEach(() => {
    cleanup();
    setRunningTurnsForTests([]);
  });

  it('is named for the built-in agent, sits bottom right, and opens on a click or ⌘J', async () => {
    const { onOpen } = mount();
    expect(await screen.findByRole('button', { name: 'Ask Marlow' })).toBeTruthy();
    expect(button().getAttribute('title')).toMatch(/^Ask Marlow {2}(⌘J|Ctrl\+J)$/);
    expect(button().style.bottom).toBe('16px');
    fireEvent.click(button());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => dispatchAppCommand('toggle-agent'));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('is gone and ignores ⌘J while hidden', () => {
    const { onOpen } = mount(true);
    expect(screen.queryByRole('button', { name: /^Ask / })).toBeNull();
    act(() => dispatchAppCommand('toggle-agent'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('snaps a drag to the nearest edge, remembers it, and doesn’t open', async () => {
    const { onOpen } = mount();
    await screen.findByRole('button', { name: 'Ask Marlow' });
    fireEvent.pointerDown(button(), { pointerId: 1, button: 0, clientX: 960, clientY: 660 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 40, clientY: 690 });
    // The corners show as slots, and the edge it will snap to is marked.
    expect(document.querySelectorAll('.wb-agent-slot')).toHaveLength(4);
    expect(document.querySelector('.wb-agent-edge.is-bottom')).toBeTruthy();
    fireEvent.pointerUp(button(), { pointerId: 1, clientX: 40, clientY: 690 });
    fireEvent.click(button());
    expect(onOpen).not.toHaveBeenCalled();
    expect(stored()).toEqual({ edge: 'bottom', along: 0 });
    expect(document.querySelector('.wb-agent-slot')).toBeNull();
    expect(button().style.left).toBe('calc(16px + 0 * (100% - 92px))');
  });

  it('treats a move under 4 pixels as a click', async () => {
    const { onOpen } = mount();
    await screen.findByRole('button', { name: 'Ask Marlow' });
    fireEvent.pointerDown(button(), { pointerId: 1, button: 0, clientX: 960, clientY: 660 });
    fireEvent.pointerMove(button(), { pointerId: 1, clientX: 962, clientY: 662 });
    fireEvent.pointerUp(button(), { pointerId: 1, clientX: 962, clientY: 662 });
    fireEvent.click(button());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
  });

  it('moves to a corner from its context menu, without dragging', async () => {
    mount();
    await screen.findByRole('button', { name: 'Ask Marlow' });
    fireEvent.contextMenu(button());
    await flushMenu();
    const menu = screen.getByRole('menu', { name: 'Move the agent button' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Bottom right',
      'Bottom left',
      'Top right',
      'Top left',
    ]);
    expect(document.activeElement).toBe(menu);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    await flushMenu();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bottom right' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Top left' }));
    await flushMenu();
    expect(stored()).toEqual({ edge: 'top', along: 0 });
    expect(menu.isConnected).toBe(false);
    expect(document.activeElement).toBe(button());
    expect(button().style.top).toBe('52px');

    fireEvent.contextMenu(button());
    await flushMenu();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await flushMenu();
    expect(document.activeElement).toBe(button());
  });

  it('shows a turn running, then a dot when the reply arrives away from Chat, cleared on opening', async () => {
    mount();
    await screen.findByRole('button', { name: 'Ask Marlow' });
    act(() => setRunningTurnsForTests([turn('r1')]));
    expect(screen.getByRole('img', { name: 'Marlow is working' })).toBeTruthy();
    act(() => setRunningTurnsForTests([]));
    expect(screen.queryByRole('img', { name: 'Marlow is working' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Marlow replied' })).toBeTruthy();
    fireEvent.click(button());
    expect(screen.queryByRole('img', { name: 'Marlow replied' })).toBeNull();
  });

  it('ignores other agents’ turns, and sets no dot for a reply that ends on Chat', async () => {
    const { rerender, onOpen } = mount();
    await screen.findByRole('button', { name: 'Ask Marlow' });
    act(() => setRunningTurnsForTests([turn('dm', 'scout')]));
    expect(screen.queryByRole('img', { name: 'Marlow is working' })).toBeNull();
    act(() => setRunningTurnsForTests([]));
    expect(screen.queryByRole('img', { name: 'Marlow replied' })).toBeNull();

    act(() => setRunningTurnsForTests([turn('r2')]));
    rerender(
      <div data-testid="area" style={{ position: 'relative' }}>
        <AgentButton hidden onOpen={onOpen} />
      </div>
    );
    act(() => setRunningTurnsForTests([]));
    rerender(
      <div data-testid="area" style={{ position: 'relative' }}>
        <AgentButton hidden={false} onOpen={onOpen} />
      </div>
    );
    await waitFor(() => expect(button()).toBeTruthy());
    expect(screen.queryByRole('img', { name: 'Marlow replied' })).toBeNull();
  });
});
