import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dialog } from 'electron';
import { findRunningSibling, refuseToStart, siblingBuildName } from '../../siblingBuild';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) } }));
vi.mock('../../persistDebugLog', () => ({
  persistDebugLog: vi.fn(),
  serializeError: (error: unknown) => ({ error: String(error) }),
}));

const entry = (index: number, name: string, id: string, type: string): string =>
  ` ${index}) "${name}" ASN:0x0-0x${index}:\n    bundleID="${id}"\n    pid = ${index + 100} type="${type}" flavor=3\n`;

const ownId = 'com.boundary.desktop';

describe('siblingBuildName', () => {
  it('finds a running build with an ID extending the family', () => {
    const listing =
      entry(1, 'Finder', 'com.apple.finder', 'Foreground') +
      entry(2, 'Boundary Beta', 'com.boundary.desktop.beta', 'Foreground');
    expect(siblingBuildName(listing, ownId)).toBe('Boundary Beta');
  });

  it('finds the default build from a build with its own ID', () => {
    const listing = entry(1, 'Boundary', ownId, 'Foreground');
    expect(siblingBuildName(listing, 'com.boundary.desktop.beta')).toBe('Boundary');
  });

  it('ignores this build, so an update’s restart overlap doesn’t refuse', () => {
    expect(siblingBuildName(entry(1, 'Boundary', ownId, 'Foreground'), ownId)).toBeNull();
  });

  it('ignores helpers and the updater', () => {
    const listing =
      entry(1, 'Boundary Helper', `${ownId}.beta.helper.Renderer`, 'UIElement') +
      entry(2, 'ShipIt', `${ownId}.beta.ShipIt`, 'BackgroundOnly');
    expect(siblingBuildName(listing, ownId)).toBeNull();
  });

  it('ignores an unrelated ID that shares the prefix text', () => {
    const listing = entry(1, 'Other', 'com.boundary.desktopper', 'Foreground');
    expect(siblingBuildName(listing, ownId)).toBeNull();
  });
});

describe('findRunningSibling', () => {
  it('lets the build start when the lookup fails', () => {
    const run = () => {
      throw new Error('lsappinfo timed out');
    };
    expect(findRunningSibling(run)).toBeNull();
  });
});

describe('refuseToStart', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the running build, then exits without running quit handlers', async () => {
    const app = { exit: vi.fn() };
    await refuseToStart(app, 'Boundary Beta');
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Boundary Beta is already running',
        detail: 'Quit Boundary Beta, then open Boundary.',
      })
    );
    expect(app.exit).toHaveBeenCalledWith(0);
  });
});
