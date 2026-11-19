import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => undefined),
  handlers: {} as Record<string, (...args: any[]) => any>,
}));

vi.mock('electron', () => ({
  shell: { openExternal: h.openExternal },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => any) => {
      h.handlers[channel] = fn;
    }),
  },
}));

const { openHttpUrlExternally, registerUrlHandlers } = await import('../openExternal');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('openHttpUrlExternally (G13-19)', () => {
  it('opens http and https URLs in the system browser', async () => {
    await expect(openHttpUrlExternally('http://localhost:8080/')).resolves.toEqual({ success: true });
    await expect(openHttpUrlExternally('https://example.com/a')).resolves.toEqual({ success: true });
    expect(h.openExternal.mock.calls).toEqual([['http://localhost:8080/'], ['https://example.com/a']]);
  });

  it('refuses other schemes and non-URLs', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'not a url', 42, undefined]) {
      expect((await openHttpUrlExternally(url)).success).toBe(false);
    }
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('reports a failed open', async () => {
    h.openExternal.mockRejectedValueOnce(new Error('no browser'));
    await expect(openHttpUrlExternally('https://example.com/')).resolves.toEqual({
      success: false,
      error: 'no browser',
    });
  });
});

describe('urls:open-url', () => {
  it('opens the URL the page sends', async () => {
    registerUrlHandlers();
    const handler = h.handlers['urls:open-url'];
    expect(handler).toBeTypeOf('function');
    await handler({}, 'https://example.com/');
    expect(h.openExternal).toHaveBeenCalledWith('https://example.com/');
  });
});
