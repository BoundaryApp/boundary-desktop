import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorBoxes, Guide, Release } from '../../../../shared/types/releaseNotes';
import type { WhatsNewSnapshot } from '../../../../shared/types/whatsNew';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetWhatsNewForTests } from '../state';
import { WhatsNewScreen } from '../WhatsNewScreen';

const release = (version: string, over: Partial<Release> = {}): Release => ({
  version,
  date: 'Nov 13',
  slides: [{ title: `Feature in ${version}`, body: 'What it does.', image: 'one' }],
  guides: [],
  ...over,
});

const CALENDARS: Guide = {
  id: 'calendars',
  title: 'Connect your Mac calendars',
  minutes: 3,
  steps: [{ title: 'Open Services', image: 'one', callouts: [] }],
};

const BUNDLED = [
  release('0.0.1-rc.11', { guides: ['calendars'] }),
  release('0.0.1-rc.10'),
  release('0.0.1-rc.9'),
];

const bundled = vi.hoisted(() => ({ releases: [] as Release[] }));
vi.mock('../content', () => ({
  loadReleases: (): Release[] => bundled.releases,
  loadGuide: (id: string): Guide | null => (id === 'calendars' ? CALENDARS : null),
  imageUrl: (): string | null => '/assets/shot.png',
  anchorBoxes: (): AnchorBoxes => ({}),
}));

const snapshot = (over: Partial<WhatsNewSnapshot> = {}): WhatsNewSnapshot => ({
  currentVersion: '0.0.1-rc.11',
  upgradedFrom: '0.0.1-rc.9',
  firstInstall: false,
  seen: ['0.0.1-rc.9'],
  popups: true,
  ...over,
});

function show(over: Partial<WhatsNewSnapshot> = {}, props: { scrollTo?: string } = {}) {
  const setPopups = vi.fn(async () => undefined);
  const markSeen = vi.fn(async () => undefined);
  stubElectronAPI({ whatsNew: { getState: vi.fn(async () => snapshot(over)), setPopups, markSeen } });
  const onOpenGuide = vi.fn();
  render(<WhatsNewScreen onOpenGuide={onOpenGuide} {...props} />);
  return { setPopups, markSeen, onOpenGuide };
}

const headings = () =>
  screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

beforeEach(() => {
  bundled.releases = BUNDLED;
});
afterEach(() => {
  resetWhatsNewForTests();
});

describe('WhatsNewScreen', () => {
  it('lists every bundled release, newest first', async () => {
    show();
    await waitFor(() => expect(headings()).toEqual(['0.0.1-rc.11', '0.0.1-rc.10', '0.0.1-rc.9']));
  });

  it('shows each release’s features', async () => {
    show();
    expect(await screen.findByRole('heading', { name: 'Feature in 0.0.1-rc.10' })).toBeTruthy();
  });

  it('badges a release the reader has not seen', async () => {
    show();
    const latest = (await screen.findByRole('heading', { name: '0.0.1-rc.11' })).closest('section');
    expect(within(latest as HTMLElement).getByText('New to you')).toBeTruthy();
    const oldest = screen.getByRole('heading', { name: '0.0.1-rc.9' }).closest('section');
    expect(within(oldest as HTMLElement).queryByText('New to you')).toBeNull();
  });

  it('lists a release’s guides that no slide links to', async () => {
    show();
    expect(await screen.findByRole('button', { name: /Connect your Mac calendars/ })).toBeTruthy();
  });

  it('opens a guide from its card', async () => {
    const { onOpenGuide } = show();
    fireEvent.click(await screen.findByRole('button', { name: /Connect your Mac calendars/ }));
    expect(onOpenGuide).toHaveBeenCalledWith('calendars');
  });

  it('shows the popup setting as it stands', async () => {
    show({ popups: false });
    const toggle = await screen.findByRole('switch', { name: /Show new releases on launch/ });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('turns popups back on from the switch', async () => {
    const { setPopups } = show({ popups: false });
    fireEvent.click(await screen.findByRole('switch', { name: /Show new releases on launch/ }));
    expect(setPopups).toHaveBeenCalledWith(true);
  });

  it('indexes the releases for jumping to one', async () => {
    show();
    expect(await screen.findByRole('button', { name: 'rc.10' })).toBeTruthy();
  });

  it('scrolls to the release it was opened at', async () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    show({}, { scrollTo: '0.0.1-rc.10' });
    await waitFor(() => expect(into).toHaveBeenCalled());
  });

  it('says so when no release notes are bundled', async () => {
    bundled.releases = [];
    show();
    expect(await screen.findByText(/No release notes yet/)).toBeTruthy();
  });
});
