import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  write: vi.fn(async (_items: unknown[]): Promise<void> => undefined),
}));

vi.mock('electron', () => ({
  clipboard: { write: h.write, readText: vi.fn(), clear: vi.fn() },
  ClipboardItem: class {
    constructor(readonly formats: Record<string, unknown>) {}
  },
}));

import { CONCEALED_FORMAT, copyThenClear, electronSecretClipboard } from '../secretClipboard';
import { fakeSecretClipboard } from './secretClipboardFake';

afterEach(() => {
  vi.useRealTimers();
  h.write.mockClear();
});

describe('electronSecretClipboard', () => {
  const formatsWritten = () => (h.write.mock.calls[0][0] as Array<{ formats: Record<string, unknown> }>)[0].formats;

  it('writes the text and the concealed marker in one write on macOS', async () => {
    await electronSecretClipboard('darwin').writeSecret('hunter2');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(Object.keys(formatsWritten())).toEqual(['text/plain', CONCEALED_FORMAT]);
    expect(formatsWritten()['text/plain']).toBe('hunter2');
  });

  it('writes the text alone elsewhere', async () => {
    await electronSecretClipboard('win32').writeSecret('hunter2');
    expect(Object.keys(formatsWritten())).toEqual(['text/plain']);
  });
});

describe('copyThenClear', () => {
  it('copies the text and clears it after exactly 60 000 ms', async () => {
    vi.useFakeTimers();
    const clipboard = fakeSecretClipboard();
    await copyThenClear(clipboard, 'hunter2');
    expect(clipboard.readText()).toBe('hunter2');
    vi.advanceTimersByTime(59_999);
    expect(clipboard.clear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clipboard.clear).toHaveBeenCalledTimes(1);
    expect(clipboard.readText()).toBe('');
  });

  it('leaves the clipboard alone when it holds something else by then', async () => {
    vi.useFakeTimers();
    const clipboard = fakeSecretClipboard();
    await copyThenClear(clipboard, 'hunter2');
    clipboard.userCopies('something else');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clipboard.clear).not.toHaveBeenCalled();
    expect(clipboard.readText()).toBe('something else');
  });

  it('rejects and sets no timer when the write fails', async () => {
    const setTimer = vi.fn();
    const clipboard = { ...fakeSecretClipboard(), writeSecret: vi.fn(async () => Promise.reject(new Error('busy'))) };
    await expect(copyThenClear(clipboard, 'hunter2', setTimer)).rejects.toThrow('busy');
    expect(setTimer).not.toHaveBeenCalled();
  });
});
