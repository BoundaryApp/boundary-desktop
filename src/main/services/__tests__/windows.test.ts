import { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcast } from '../windows';

function fakeWindow(destroyed: boolean) {
  return { isDestroyed: () => destroyed, webContents: { isDestroyed: () => destroyed, send: vi.fn() } };
}

describe('broadcast', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends to every live window and skips destroyed ones', () => {
    const live = fakeWindow(false);
    const gone = fakeWindow(true);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([live, gone] as never);
    broadcast('calendars:progress', { step: 1 });
    expect(live.webContents.send).toHaveBeenCalledWith('calendars:progress', { step: 1 });
    expect(gone.webContents.send).not.toHaveBeenCalled();
  });

  it('sends no argument when given no payload', () => {
    const live = fakeWindow(false);
    vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([live] as never);
    broadcast('calendars:changed');
    expect(live.webContents.send).toHaveBeenCalledWith('calendars:changed');
  });
});
