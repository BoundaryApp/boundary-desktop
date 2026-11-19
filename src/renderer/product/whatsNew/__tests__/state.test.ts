import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnchorBoxes, Guide, Release } from '../../../../shared/types/releaseNotes';
import type { WhatsNewSnapshot } from '../../../../shared/types/whatsNew';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetWhatsNewForTests, useWhatsNew, type WhatsNewView } from '../state';

const release = (version: string): Release => ({
  version,
  date: 'Nov 13',
  slides: [{ title: `What ${version} brought`, body: 'A sentence.', image: 'one' }],
  guides: [],
});

const BUNDLED = [release('0.0.1-rc.11'), release('0.0.1-rc.10'), release('0.0.1-rc.9')];

const bundled = vi.hoisted(() => ({ releases: [] as Release[] }));
vi.mock('../content', () => ({
  loadReleases: (): Release[] => bundled.releases,
  loadGuide: (): Guide | null => null,
  imageUrl: (): string | null => null,
  anchorBoxes: (): AnchorBoxes => ({}),
}));

const snapshot = (over: Partial<WhatsNewSnapshot> = {}): WhatsNewSnapshot => ({
  currentVersion: '0.0.1-rc.11',
  upgradedFrom: '0.0.1-rc.9',
  firstInstall: false,
  seen: [],
  popups: true,
  ...over,
});

async function view(over: Partial<WhatsNewSnapshot> = {}): Promise<{ current: WhatsNewView | null }> {
  stubElectronAPI({ whatsNew: { getState: vi.fn(async () => snapshot(over)) } });
  const { result } = renderHook(() => useWhatsNew());
  await waitFor(() => expect(result.current).not.toBeNull());
  return result;
}

beforeEach(() => {
  bundled.releases = BUNDLED;
});
afterEach(() => {
  resetWhatsNewForTests();
});

describe('useWhatsNew', () => {
  it('offers the popup for an unseen upgrade', async () => {
    expect((await view()).current?.pendingPopup).toBe(true);
  });

  it('offers no popup on a first install', async () => {
    const result = await view({ upgradedFrom: null, firstInstall: true, seen: ['0.0.1-rc.11'] });
    expect(result.current?.pendingPopup).toBe(false);
  });

  it('offers no popup once popups are off', async () => {
    expect((await view({ popups: false })).current?.pendingPopup).toBe(false);
  });

  it('offers no popup once the release has been seen', async () => {
    expect((await view({ seen: ['0.0.1-rc.11'] })).current?.pendingPopup).toBe(false);
  });

  it('lists the releases between the one upgraded from and the current one', async () => {
    const result = await view();
    expect(result.current?.missed.map((item) => item.version)).toEqual(['0.0.1-rc.10']);
  });

  it('lists no missed releases when the earlier version is unknown', async () => {
    expect((await view({ upgradedFrom: 'unknown' })).current?.missed).toEqual([]);
  });

  it('lists no missed releases when the earlier version is not bundled', async () => {
    expect((await view({ upgradedFrom: '0.0.1-rc.2' })).current?.missed).toEqual([]);
  });

  it('lists no missed releases when the upgrade was from the release before', async () => {
    expect((await view({ upgradedFrom: '0.0.1-rc.10' })).current?.missed).toEqual([]);
  });

  it('keeps a missed release unread after the current one is read', async () => {
    const result = await view({ seen: ['0.0.1-rc.11'] });
    expect(result.current?.missed.map((item) => item.version)).toEqual(['0.0.1-rc.10']);
    expect(result.current?.unread('0.0.1-rc.10')).toBe(true);
    expect(result.current?.unread('0.0.1-rc.11')).toBe(false);
  });

  it('counts no release this install already ran as unread', async () => {
    const result = await view({ seen: [] });
    expect(result.current?.unread('0.0.1-rc.9')).toBe(false);
  });

  it('marks the rail while a release is unseen', async () => {
    expect((await view()).current?.unseen).toBe(true);
  });

  it('clears the rail mark once the current and missed releases are seen', async () => {
    const result = await view({ seen: ['0.0.1-rc.11', '0.0.1-rc.10'] });
    expect(result.current?.unseen).toBe(false);
  });

  it('keeps the rail marked while a missed release is unread', async () => {
    expect((await view({ seen: ['0.0.1-rc.11'] })).current?.unseen).toBe(true);
  });

  it('has nothing to show for a release with no slides', async () => {
    bundled.releases = [{ ...BUNDLED[0], slides: [] }, BUNDLED[1], BUNDLED[2]];
    const result = await view();
    expect(result.current?.pendingPopup).toBe(false);
    expect(result.current?.unread('0.0.1-rc.11')).toBe(false);
  });

  it('reports nothing to show when no content is bundled', async () => {
    bundled.releases = [];
    const result = await view();
    expect(result.current?.current).toBeNull();
    expect(result.current?.releases).toEqual([]);
    expect(result.current?.unseen).toBe(false);
    expect(result.current?.pendingPopup).toBe(false);
  });

  it('follows a change main broadcasts', async () => {
    let push: ((state: WhatsNewSnapshot) => void) | null = null;
    stubElectronAPI({
      whatsNew: {
        getState: vi.fn(async () => snapshot()),
        onState: vi.fn((listener: (state: WhatsNewSnapshot) => void): (() => void) => {
          push = listener;
          return () => undefined;
        }),
      },
    });
    const { result } = renderHook(() => useWhatsNew());
    await waitFor(() => expect(result.current).not.toBeNull());
    act(() => push?.(snapshot({ popups: false })));
    expect(result.current?.popups).toBe(false);
  });

  it('sends a release that has been read to main', async () => {
    const markSeen = vi.fn(async () => undefined);
    stubElectronAPI({ whatsNew: { getState: vi.fn(async () => snapshot()), markSeen } });
    const { result } = renderHook(() => useWhatsNew());
    await waitFor(() => expect(result.current).not.toBeNull());
    result.current?.markSeen('0.0.1-rc.11');
    expect(markSeen).toHaveBeenCalledWith('0.0.1-rc.11');
  });

  it('sends the popup setting to main', async () => {
    const setPopups = vi.fn(async () => undefined);
    stubElectronAPI({ whatsNew: { getState: vi.fn(async () => snapshot()), setPopups } });
    const { result } = renderHook(() => useWhatsNew());
    await waitFor(() => expect(result.current).not.toBeNull());
    result.current?.setPopups(false);
    expect(setPopups).toHaveBeenCalledWith(false);
  });
});
