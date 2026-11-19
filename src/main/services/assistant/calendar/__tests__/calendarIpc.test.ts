import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
  openExternal: vi.fn(async (_url: string) => undefined),
  restart: vi.fn(async () => ({ access: 'granted', calendars: [] })),
}));

vi.mock('electron', () => ({ shell: { openExternal: h.openExternal } }));
vi.mock('../../../../ipc', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
    h.handlers[channel] = fn;
  },
  handleResult: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
    h.handlers[channel] = fn;
  },
}));
vi.mock('../calendarService', () => ({}));
vi.mock('../macCalendarAccount', () => ({ restartMacCalendarHelper: h.restart }));

import { registerCalendarHandlers } from '../calendarIpc';

const URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars';

describe('calendars:open-privacy-settings', () => {
  beforeEach(() => {
    h.openExternal.mockReset();
    h.openExternal.mockResolvedValue(undefined);
    registerCalendarHandlers();
  });

  it('opens the Calendars privacy pane and ignores any argument', async () => {
    const handler = h.handlers['calendars:open-privacy-settings'];
    await expect(handler({}, 'https://example.com/')).resolves.toEqual({ success: true });
    expect(h.openExternal).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith(URL);
  });

  it('reports a failure to open', async () => {
    h.openExternal.mockRejectedValue(new Error('no handler'));
    await expect(h.handlers['calendars:open-privacy-settings']({})).resolves.toEqual({ success: false, error: 'no handler' });
  });
});

describe('calendars:mac-restart-helper', () => {
  beforeEach(() => {
    h.restart.mockClear();
    registerCalendarHandlers();
  });

  it('restarts the helper and answers with the new status, ignoring any argument', async () => {
    await expect(h.handlers['calendars:mac-restart-helper']({}, { anything: true })).resolves.toEqual({
      access: 'granted',
      calendars: [],
    });
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.restart).toHaveBeenCalledWith();
  });
});
