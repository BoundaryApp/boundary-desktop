import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({} as Record<string, (...args: any[]) => any>));
vi.mock('../ipc', () => ({
  handle: (channel: string, fn: (...args: any[]) => any) => {
    handlers[channel] = fn;
  },
}));

import { confirmQuitDuringCall, isCallLive, quitDialogOn, registerCallHandlers, setCallLive, type QuitWindow } from '../callQuit';

describe('confirmQuitDuringCall', () => {
  beforeEach(() => setCallLive(false));

  it('quits at once with no call', async () => {
    const show = vi.fn();
    expect(await confirmQuitDuringCall(show)).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it('asks during a call and quits on Quit', async () => {
    setCallLive(true);
    const show = vi.fn().mockResolvedValue({ response: 0 });
    expect(await confirmQuitDuringCall(show)).toBe(true);
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "You're in a call",
        detail: 'Quitting leaves it.',
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      })
    );
  });

  it('stays on Cancel', async () => {
    setCallLive(true);
    expect(await confirmQuitDuringCall(vi.fn().mockResolvedValue({ response: 1 }))).toBe(false);
  });

  it("a second quit while asking doesn't ask twice", async () => {
    setCallLive(true);
    let answer!: (r: { response: number }) => void;
    const show = vi.fn(() => new Promise<{ response: number }>((resolve) => (answer = resolve)));
    const first = confirmQuitDuringCall(show);
    expect(await confirmQuitDuringCall(show)).toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    answer({ response: 0 });
    expect(await first).toBe(true);
    // The dialog is closed again, so a later quit asks anew.
    await confirmQuitDuringCall(vi.fn().mockResolvedValue({ response: 1 }));
  });

  it('a dialog that fails counts as Cancel', async () => {
    setCallLive(true);
    expect(await confirmQuitDuringCall(vi.fn().mockRejectedValue(new Error('no window')))).toBe(false);
    // Not stuck asking: the next quit asks again.
    const show = vi.fn().mockResolvedValue({ response: 0 });
    expect(await confirmQuitDuringCall(show)).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

function fakeWindow(visible: boolean, minimized = false): QuitWindow & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => {
      calls.push('show');
      visible = true;
    },
    focus: () => calls.push('focus'),
  };
}

describe('quitDialogOn', () => {
  const OPTIONS = { message: "You're in a call" };

  it('shows the window before asking when it is hidden', async () => {
    const win = fakeWindow(false);
    const sheet = vi.fn(async () => {
      win.calls.push('sheet');
      return { response: 1 };
    });
    const plain = vi.fn();
    await quitDialogOn(win, sheet, plain)(OPTIONS);
    expect(win.calls).toEqual(['show', 'focus', 'sheet']);
    expect(sheet).toHaveBeenCalledWith(win, OPTIONS);
    expect(plain).not.toHaveBeenCalled();
  });

  it('restores a minimized window before asking', async () => {
    const win = fakeWindow(true, true);
    await quitDialogOn(win, async () => ({ response: 1 }), vi.fn())(OPTIONS);
    expect(win.calls).toEqual(['restore', 'focus']);
  });

  it('asks with no parent when there is no window', async () => {
    const plain = vi.fn().mockResolvedValue({ response: 0 });
    const sheet = vi.fn();
    expect(await quitDialogOn(null, sheet, plain)(OPTIONS)).toEqual({ response: 0 });
    const destroyed = { ...fakeWindow(true), isDestroyed: () => true };
    await quitDialogOn(destroyed, sheet, plain)(OPTIONS);
    expect(plain).toHaveBeenCalledTimes(2);
    expect(sheet).not.toHaveBeenCalled();
  });
});

describe('calls:live', () => {
  const live = (sender: EventEmitter, on: boolean) => handlers['calls:live']({ sender }, on);

  beforeEach(() => {
    setCallLive(false);
    registerCallHandlers();
  });

  it('clears when the page that set it is destroyed', () => {
    const sender = new EventEmitter();
    live(sender, true);
    sender.emit('destroyed');
    expect(isCallLive()).toBe(false);
  });

  it('clears when the renderer crashes', () => {
    const sender = new EventEmitter();
    live(sender, true);
    sender.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(isCallLive()).toBe(false);
  });

  it('clears when the page reloads or navigates, but not for a frame or an in-page change', () => {
    const sender = new EventEmitter();
    live(sender, true);
    sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(isCallLive()).toBe(true);
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(isCallLive()).toBe(false);
  });

  it("another page going away leaves the flag, and a sender is watched once", () => {
    const first = new EventEmitter();
    const second = new EventEmitter();
    live(first, true);
    live(first, false);
    live(first, true);
    expect(first.listenerCount('destroyed')).toBe(1);
    live(second, true);
    first.emit('destroyed');
    expect(isCallLive()).toBe(true);
    second.emit('destroyed');
    expect(isCallLive()).toBe(false);
  });

  it('the live flag follows calls:live', () => {
    setCallLive(false);
    registerCallHandlers();
    handlers['calls:live']({}, true);
    expect(isCallLive()).toBe(true);
    handlers['calls:live']({}, false);
    expect(isCallLive()).toBe(false);
    expect(() => handlers['calls:live']({}, 'yes')).toThrow();
    expect(isCallLive()).toBe(false);
  });
});
