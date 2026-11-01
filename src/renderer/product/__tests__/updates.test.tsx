import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSnapshot } from '../../../shared/types/updates';
import { resetUpdatesForTests, UpdateCard, UpdateRailButton, useUpdates } from '../updates';
import { UpdatesPanel } from '../UpdatesPanel';

const base: UpdateSnapshot = {
  currentVersion: '0.0.1-rc.9',
  channel: 'beta',
  checksEnabled: true,
  blocked: 'none',
  phase: 'available',
  version: '0.0.1-rc.10',
  summary: ['Chats remember their project.'],
  size: 324000000,
  downloadPercent: null,
  stackChanges: false,
  checking: false,
  lastCheckedAt: null,
  error: null,
  keyRequired: false,
  showCard: true,
  waiting: [],
  restartIn: null,
  restarting: false,
  updated: null,
  showUpdated: false,
};

const task = { id: 'task:1', kind: 'task' as const, title: 'Summarize invoices', detail: 'Board task' };

function mockApi(state: UpdateSnapshot) {
  let push: (next: UpdateSnapshot) => void = () => undefined;
  let requestRestart: () => void = () => undefined;
  const api = {
    getState: vi.fn(async () => state),
    onState: vi.fn((callback: (next: UpdateSnapshot) => void) => {
      push = callback;
      return () => undefined;
    }),
    onRestartRequested: vi.fn((callback: () => void) => {
      requestRestart = callback;
      return () => undefined;
    }),
    download: vi.fn(async () => state),
    closeCard: vi.fn(async () => undefined),
    closeUpdated: vi.fn(async () => undefined),
    restart: vi.fn(async () => ({ status: 'restarting' })),
    restartWhenFinished: vi.fn(async () => undefined),
    cancelWaiting: vi.fn(async () => undefined),
    skipVersion: vi.fn(async () => undefined),
    setFeedKey: vi.fn(async () => state),
    setChannel: vi.fn(async () => state),
    setChecksEnabled: vi.fn(async () => state),
    moveToApplications: vi.fn(async () => undefined),
    check: vi.fn(async () => state),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { updates: api };
  return {
    api,
    push: (next: UpdateSnapshot) => act(() => push(next)),
    requestRestart: () => act(async () => requestRestart()),
  };
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    render(element);
  });
}

const openUpdates = vi.fn();
const card = <UpdateCard onOpenUpdates={openUpdates} />;

/** The rail shows the button once a snapshot names a version, as ProductIconRail does. */
const Rail: React.FC = () => (useUpdates()?.version ? <UpdateRailButton /> : null);

describe('updates', () => {
  beforeEach(() => {
    resetUpdatesForTests();
    openUpdates.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('asks before downloading, then offers the restart', async () => {
    const { api, push } = mockApi(base);
    await mount(card);
    expect(screen.getByText(/0\.0\.1-rc\.10 is available/)).toBeTruthy();
    expect(screen.getByText('324 MB')).toBeTruthy();
    expect(api.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(api.download).toHaveBeenCalledOnce();
    push({ ...base, phase: 'downloading' });
    expect(screen.getByText(/Downloading Boundary/)).toBeTruthy();
    push({ ...base, phase: 'ready' });
    expect(screen.getByText(/installs when you quit/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    });
    expect(api.restart).toHaveBeenCalledWith({ force: false });
  });

  it('fills the bar and the ring with the download, then loops while Squirrel checks', async () => {
    const { push } = mockApi({ ...base, phase: 'downloading', downloadPercent: 42 });
    await mount(
      <>
        {card}
        <Rail />
      </>
    );
    expect(screen.getByText('42% of 324 MB')).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Update download' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('42%');
    const ring = document.querySelector('.wb-update-ring');
    expect(ring?.classList.contains('is-sweeping')).toBe(false);
    expect(Number(ring?.querySelector('.is-arc')?.getAttribute('stroke-dashoffset'))).toBeCloseTo(75.4 * 0.58);

    push({ ...base, phase: 'downloading', downloadPercent: 100 });
    expect(screen.getByRole('heading', { name: /Checking Boundary/ })).toBeTruthy();
    expect(screen.getByText('324 MB')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(document.querySelector('.wb-update-ring')?.classList.contains('is-sweeping')).toBe(true);
  });

  it('loops when the total is unknown', async () => {
    mockApi({ ...base, phase: 'downloading', size: null, downloadPercent: null });
    await mount(card);
    expect(screen.getByRole('heading', { name: /Downloading Boundary/ })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows the percent on the Updates page', async () => {
    mockApi({ ...base, phase: 'downloading', downloadPercent: 42, showCard: false });
    await mount(<UpdatesPanel />);
    expect(screen.getByText('42% of 324 MB. Keep working.')).toBeTruthy();
  });

  it('warns about a slow next start when the update moves the stack', async () => {
    mockApi({ ...base, phase: 'ready', stackChanges: true });
    await mount(card);
    expect(screen.getByText(/next start takes a few minutes/)).toBeTruthy();
  });

  it('names running work and defaults to waiting for it', async () => {
    const { api } = mockApi({ ...base, phase: 'ready' });
    api.restart.mockResolvedValueOnce({ status: 'work-running', items: [task] } as never);
    await mount(card);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    });
    expect(screen.getByText('Summarize invoices')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart when finished' }));
    expect(api.restartWhenFinished).toHaveBeenCalledWith([task]);
  });

  it('runs the running-work check when the menu asks for a restart', async () => {
    const { api, requestRestart } = mockApi({ ...base, phase: 'ready', showCard: false });
    await mount(card);
    await requestRestart();
    expect(api.restart).toHaveBeenCalledWith({ force: false });
  });

  it('collapses on Later and on a click elsewhere, and the rail button reopens it', async () => {
    const { api, push } = mockApi(base);
    await mount(
      <>
        {card}
        <Rail />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(api.closeCard).toHaveBeenCalledOnce();
    push({ ...base, showCard: false });
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /is available/ }));
    expect(screen.getByRole('status')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps a click on the rail button from counting as a click elsewhere', async () => {
    mockApi({ ...base, showCard: false });
    await mount(
      <>
        {card}
        <Rail />
      </>
    );
    const button = screen.getByRole('button', { name: /is available/ });
    fireEvent.click(button);
    fireEvent.pointerDown(button);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('tells a failed download apart and offers a retry', async () => {
    mockApi({ ...base, error: 'download' });
    await mount(card);
    expect(screen.getByText(/didn’t download/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('ticks off waited-for work', async () => {
    mockApi({
      ...base,
      phase: 'ready',
      showCard: false,
      waiting: [
        { ...task, finished: true },
        { ...task, id: 'task:2', title: 'Fix login redirect', finished: false },
      ],
    });
    await mount(
      <>
        {card}
        <Rail />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restarting when work finishes' }));
    expect(screen.getByText('Restarting when 1 task finishes')).toBeTruthy();
    expect(screen.getByText('Summarize invoices').closest('li')?.className).toContain('is-finished');
  });

  it('holds the last call open through a click elsewhere, and Not now cancels it', async () => {
    const { api } = mockApi({ ...base, phase: 'ready', showCard: false, restartIn: 22 });
    await mount(card);
    expect(screen.getByText('Restarting in 22 seconds')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.getByText('Restarting in 22 seconds')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(api.cancelWaiting).toHaveBeenCalledOnce();
  });

  it('confirms a finished update, then closes after ten seconds', async () => {
    vi.useFakeTimers();
    const updated = { version: '0.0.1-rc.9', summary: ['Chats remember their project.'] };
    const { api } = mockApi({
      ...base,
      phase: 'idle',
      version: null,
      showCard: false,
      updated,
      showUpdated: true,
    });
    await mount(card);
    expect(screen.getByText('Boundary is now 0.0.1-rc.9')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(api.closeUpdated).toHaveBeenCalledOnce();
  });

  it('opens the Updates page from See what changed', async () => {
    mockApi({
      ...base,
      phase: 'idle',
      version: null,
      showCard: false,
      updated: { version: '0.0.1-rc.9', summary: [] },
      showUpdated: true,
    });
    await mount(card);
    fireEvent.click(screen.getByRole('button', { name: 'See what changed' }));
    expect(openUpdates).toHaveBeenCalledOnce();
  });

  it('closes the card when the Updates tab opens', async () => {
    const { api } = mockApi(base);
    await mount(<UpdatesPanel />);
    expect(api.closeCard).toHaveBeenCalledOnce();
  });

  it('leads the page with where things stand', async () => {
    mockApi({ ...base, phase: 'idle', version: null, summary: [], showCard: false });
    await mount(<UpdatesPanel />);
    expect(screen.getByRole('heading', { name: 'Boundary is up to date' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('shows a failed download at the top of the page', async () => {
    mockApi({ ...base, error: 'download', showCard: false });
    await mount(<UpdatesPanel />);
    expect(screen.getByRole('heading', { name: /didn’t download/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('keeps What’s new on the page after the update installed', async () => {
    mockApi({
      ...base,
      phase: 'idle',
      version: null,
      summary: [],
      showCard: false,
      updated: { version: '0.0.1-rc.9', summary: ['Search answers sooner.'] },
    });
    await mount(<UpdatesPanel />);
    expect(screen.getByRole('heading', { name: 'What’s new in 0.0.1-rc.9' })).toBeTruthy();
    expect(screen.getByText('Search answers sooner.')).toBeTruthy();
  });

  it('explains a build outside Applications and offers the move', async () => {
    const { api } = mockApi({ ...base, phase: 'idle', version: null, blocked: 'not-in-applications' });
    await mount(<UpdatesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Applications' }));
    expect(api.moveToApplications).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('asks for a key on a gated build and says the key identifies the person', async () => {
    const { api } = mockApi({
      ...base,
      phase: 'idle',
      version: null,
      blocked: 'no-key',
      keyRequired: true,
    });
    await mount(<UpdatesPanel />);
    expect(screen.getByRole('heading', { name: 'Enter your update key' })).toBeTruthy();
    expect(screen.getByText(/Your update key identifies you/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Update key'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    expect(api.setFeedKey).toHaveBeenCalledWith('abc');
  });

  it('keeps the key row off a public build', async () => {
    mockApi({ ...base, phase: 'idle', version: null });
    await mount(<UpdatesPanel />);
    expect(screen.queryByLabelText('Update key')).toBeNull();
  });
});
