import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';

vi.mock('../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

import {
  applyAppBadge,
  LINUX_DESKTOP_NAME,
  resetAppBadgeLogForTests,
  type AppBadgeTarget,
} from '../appBadge';

const OVERLAY = 'data:image/png;base64,AAAA';

function target(platform: NodeJS.Platform, overrides: Partial<AppBadgeTarget> = {}) {
  const win = { isDestroyed: vi.fn(() => false), setOverlayIcon: vi.fn() };
  const image = { isEmpty: () => false } as NativeImage;
  const setBadgeCount = vi.fn<(count: number) => boolean>(() => true);
  const t: AppBadgeTarget = {
    platform,
    setBadgeCount,
    window: vi.fn(() => win),
    image: vi.fn(() => image),
    log: vi.fn(),
    ...overrides,
  };
  return { t, win, image, setBadgeCount };
}

beforeEach(() => resetAppBadgeLogForTests());

describe('applyAppBadge', () => {
  it.each(['darwin', 'linux'] as const)('sets the count badge on %s', (platform) => {
    const { t, win, setBadgeCount } = target(platform);
    applyAppBadge({ count: 7 }, t);
    applyAppBadge({ count: 0 }, t);
    expect(setBadgeCount.mock.calls).toEqual([[7], [0]]);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });

  it('logs once, without the count, when the OS refuses the badge', () => {
    const log = vi.fn();
    const { t } = target('darwin', { setBadgeCount: vi.fn(() => false), log });
    applyAppBadge({ count: 2 }, t);
    applyAppBadge({ count: 3 }, t);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('badge not shown', { platform: 'darwin' });
  });

  it('puts the overlay on the Windows taskbar button and removes it at 0', () => {
    const { t, win, image, setBadgeCount } = target('win32');
    applyAppBadge({ count: 4, overlay: OVERLAY }, t);
    expect(t.image).toHaveBeenCalledWith(OVERLAY);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(image, '4 unread');

    applyAppBadge({ count: 0 }, t);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('removes the Windows overlay when the image is missing or empty', () => {
    const { t, win } = target('win32', { image: vi.fn(() => ({ isEmpty: () => true }) as NativeImage) });
    applyAppBadge({ count: 4 }, t);
    applyAppBadge({ count: 4, overlay: OVERLAY }, t);
    expect(win.setOverlayIcon.mock.calls).toEqual([
      [null, ''],
      [null, ''],
    ]);
  });

  it('skips Windows when there is no live main window', () => {
    const { t, win } = target('win32', { window: vi.fn(() => undefined) });
    applyAppBadge({ count: 4, overlay: OVERLAY }, t);
    win.isDestroyed.mockReturnValue(true);
    const destroyed = target('win32', { window: vi.fn(() => win) });
    applyAppBadge({ count: 4, overlay: OVERLAY }, destroyed.t);
    expect(win.setOverlayIcon).not.toHaveBeenCalled();
  });

  it('does nothing on other platforms', () => {
    const { t, setBadgeCount } = target('freebsd');
    applyAppBadge({ count: 1 }, t);
    expect(setBadgeCount).not.toHaveBeenCalled();
  });
});

describe('LINUX_DESKTOP_NAME', () => {
  it("matches package.json's name, which the deb and rpm makers name the .desktop file after", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    expect(LINUX_DESKTOP_NAME).toBe(`${pkg.name}.desktop`);
  });
});
