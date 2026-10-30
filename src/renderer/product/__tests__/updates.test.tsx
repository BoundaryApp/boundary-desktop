import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateSnapshot } from '../../../shared/types/updates';
import { resetUpdatesForTests, UpdateNotice } from '../updates';
import { UpdatesPanel } from '../UpdatesPanel';

const base: UpdateSnapshot = {
  currentVersion: '0.0.1-rc.9',
  channel: 'beta',
  checksEnabled: true,
  blocked: 'none',
  phase: 'available',
  version: '0.0.1-rc.10',
  summary: 'Chats remember their project.',
  checking: false,
  lastCheckedAt: null,
  error: null,
  showNotice: true,
  showDot: true,
  waitingFor: 0,
};

function mockApi(state: UpdateSnapshot) {
  let push: (next: UpdateSnapshot) => void = () => undefined;
  const api = {
    getState: vi.fn(async () => state),
    onState: vi.fn((callback: (next: UpdateSnapshot) => void) => {
      push = callback;
      return () => undefined;
    }),
    download: vi.fn(async () => state),
    closeNotice: vi.fn(async () => undefined),
    restart: vi.fn(async () => ({ status: 'restarting' })),
    restartWhenFinished: vi.fn(async () => undefined),
    cancelWaiting: vi.fn(async () => undefined),
    pageSeen: vi.fn(async () => undefined),
    skipVersion: vi.fn(async () => undefined),
    setChannel: vi.fn(async () => state),
    setChecksEnabled: vi.fn(async () => state),
    moveToApplications: vi.fn(async () => undefined),
    check: vi.fn(async () => state),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { updates: api };
  return { api, push: (next: UpdateSnapshot) => act(() => push(next)) };
}

async function mount(element: React.ReactElement) {
  await act(async () => {
    render(element);
  });
}

describe('updates', () => {
  beforeEach(() => resetUpdatesForTests());
  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('asks before downloading, then offers the restart', async () => {
    const { api, push } = mockApi(base);
    await mount(<UpdateNotice />);
    expect(screen.getByText(/0\.0\.1-rc\.10 is available/)).toBeTruthy();
    expect(api.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(api.download).toHaveBeenCalledOnce();
    push({ ...base, phase: 'downloading' });
    expect(screen.getByText(/Downloading Boundary/)).toBeTruthy();
    push({ ...base, phase: 'ready' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    });
    expect(api.restart).toHaveBeenCalledWith({ force: false });
  });

  it('names running work and defaults to waiting for it', async () => {
    const { api } = mockApi({ ...base, phase: 'ready' });
    const items = [{ id: 'task:1', title: 'Summarise invoices', detail: 'Board task' }];
    api.restart.mockResolvedValueOnce({ status: 'work-running', items } as never);
    await mount(<UpdateNotice />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart to install' }));
    });
    expect(screen.getByText('Summarise invoices')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart when finished' }));
    expect(api.restartWhenFinished).toHaveBeenCalledWith(items);
  });

  it('shows nothing once the notice is closed', async () => {
    mockApi({ ...base, showNotice: false });
    await mount(<UpdateNotice />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers a retry after a failed download', async () => {
    mockApi({ ...base, error: 'download' });
    await mount(<UpdateNotice />);
    expect(screen.getByText(/didn’t download/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('clears the dot when the Updates tab opens', async () => {
    const { api } = mockApi(base);
    await mount(<UpdatesPanel />);
    expect(api.pageSeen).toHaveBeenCalledOnce();
  });

  it('explains a build outside Applications and offers the move', async () => {
    const { api } = mockApi({ ...base, phase: 'idle', version: null, blocked: 'not-in-applications' });
    await mount(<UpdatesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Move to Applications' }));
    expect(api.moveToApplications).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
