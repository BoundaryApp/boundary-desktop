import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedServiceProgress } from '../../../../shared/assistantStackLifecycle';
import type { AnchorBoxes, Guide, Release } from '../../../../shared/types/releaseNotes';
import type { WhatsNewSnapshot } from '../../../../shared/types/whatsNew';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetWhatsNewForTests } from '../../whatsNew/state';
import { STORY_CARD_MS, STORY_DELAY_MS, StartupScreen } from '../StartupScreen';

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
vi.mock('../../whatsNew/content', () => ({
  loadReleases: (): Release[] => bundled.releases,
  loadGuide: (): Guide | null => null,
  imageUrl: (): string | null => '/assets/shot.png',
  anchorBoxes: (): AnchorBoxes => ({}),
}));

const openWhatsNew = vi.hoisted(() => vi.fn());
vi.mock('../../whatsNew/WhatsNewLayer', () => ({ openWhatsNew }));

const services = seedServiceProgress('pending', 'Queued…', 0.05);
const reduced = { matches: false };

function startup(over: Partial<WhatsNewSnapshot> = {}) {
  stubElectronAPI({
    whatsNew: {
      getState: vi.fn(async () => ({
        currentVersion: LATEST.version,
        upgradedFrom: '0.0.1-rc.10',
        firstInstall: false,
        seen: [],
        popups: true,
        ...over,
      })),
    },
  });
  render(<StartupScreen variant="launch" stage="compose" services={services} />);
  // The story slot only appears once a launch is slow enough to be worth reading.
  act(() => vi.advanceTimersByTime(STORY_DELAY_MS + 1_000));
}

beforeEach(() => {
  bundled.releases = [LATEST];
  reduced.matches = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') ? reduced.matches : true,
    media: query,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetWhatsNewForTests();
  openWhatsNew.mockReset();
});

describe('What’s new on the start-up screen', () => {
  it('shows the card on an unseen upgrade', async () => {
    startup();
    expect(await screen.findByText('New in this version')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'React to Circle messages' })).toBeTruthy();
  });

  it('names the version', async () => {
    startup();
    expect(await screen.findByText('rc.11')).toBeTruthy();
  });

  it('keeps the tool story when there is nothing new', async () => {
    startup({ upgradedFrom: null, seen: [LATEST.version] });
    await act(async () => undefined);
    expect(screen.queryByText('New in this version')).toBeNull();
  });

  it('keeps the tool story when no release notes are bundled', async () => {
    bundled.releases = [];
    startup();
    await act(async () => undefined);
    expect(screen.queryByText('New in this version')).toBeNull();
  });

  it('shows the card even when popups are off', async () => {
    startup({ popups: false });
    expect(await screen.findByText('New in this version')).toBeTruthy();
  });

  it('advances on the story timer', async () => {
    startup();
    await screen.findByText('New in this version');
    act(() => vi.advanceTimersByTime(STORY_CARD_MS));
    expect(screen.getByRole('heading', { name: 'Queue a follow-up' })).toBeTruthy();
  });

  it('does not advance under reduced motion', async () => {
    reduced.matches = true;
    startup();
    await screen.findByText('New in this version');
    act(() => vi.advanceTimersByTime(STORY_CARD_MS * 3));
    expect(screen.getByRole('heading', { name: 'React to Circle messages' })).toBeTruthy();
  });

  it('opens the slideshow at the slide it is showing', async () => {
    startup();
    await screen.findByText('New in this version');
    fireEvent.click(screen.getByRole('button', { name: 'Show Queue a follow-up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read more' }));
    expect(openWhatsNew).toHaveBeenCalledWith(1);
  });
});
