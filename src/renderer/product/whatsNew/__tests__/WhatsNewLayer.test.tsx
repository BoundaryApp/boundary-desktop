import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorBoxes, Guide, Release } from '../../../../shared/types/releaseNotes';
import type { WhatsNewSnapshot } from '../../../../shared/types/whatsNew';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetWhatsNewForTests } from '../state';
import { WhatsNewLayer, openWhatsNew } from '../WhatsNewLayer';

const LATEST: Release = {
  version: '0.0.1-rc.11',
  date: 'Nov 13',
  slides: [
    { title: 'React to Circle messages', body: 'Hover a message.', image: 'one' },
    { title: 'Queue a follow-up', body: 'Press Enter.', image: 'two' },
  ],
  guides: [],
};

const bundled = vi.hoisted(() => ({ releases: [] as Release[] }));
vi.mock('../content', () => ({
  loadReleases: (): Release[] => bundled.releases,
  loadGuide: (): Guide | null => null,
  imageUrl: (): string | null => '/assets/shot.png',
  anchorBoxes: (): AnchorBoxes => ({}),
}));

const snapshot = (over: Partial<WhatsNewSnapshot> = {}): WhatsNewSnapshot => ({
  currentVersion: LATEST.version,
  upgradedFrom: '0.0.1-rc.10',
  firstInstall: false,
  seen: [],
  popups: true,
  ...over,
});

function mount(over: Partial<WhatsNewSnapshot> = {}) {
  const markSeen = vi.fn(async () => undefined);
  const setPopups = vi.fn(async () => undefined);
  stubElectronAPI({
    whatsNew: { getState: vi.fn(async () => snapshot(over)), markSeen, setPopups },
  });
  render(<WhatsNewLayer onOpenPage={vi.fn()} onOpenGuide={vi.fn()} />);
  return { markSeen, setPopups };
}

beforeEach(() => {
  bundled.releases = [LATEST];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  resetWhatsNewForTests();
});

describe('WhatsNewLayer', () => {
  it('opens the slideshow on an unseen upgrade', async () => {
    mount();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('stays shut on a first install', async () => {
    mount({ upgradedFrom: null, firstInstall: true, seen: [LATEST.version] });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays shut when popups are off', async () => {
    mount({ popups: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks the release seen when it closes', async () => {
    const { markSeen } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(markSeen).toHaveBeenCalledWith(LATEST.version);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('turns popups off and offers Undo', async () => {
    const { setPopups, markSeen } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Don’t show again' }));
    expect(setPopups).toHaveBeenCalledWith(false);
    expect(markSeen).toHaveBeenCalledWith(LATEST.version);
    expect(screen.getByText(/They’re still under What’s new in the rail/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(setPopups).toHaveBeenLastCalledWith(true);
  });

  it('drops the toast after a few seconds', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Don’t show again' }));
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(6_000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('opens at the slide the start-up card was showing', async () => {
    mount({ popups: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => openWhatsNew(1));
    expect(screen.getByRole('heading', { name: 'Queue a follow-up' })).toBeTruthy();
  });

  it('does not reopen once it has been closed', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows nothing when no release notes are bundled', async () => {
    bundled.releases = [];
    mount();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
