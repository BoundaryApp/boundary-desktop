import { ipcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistDebugLog = vi.hoisted(() => vi.fn());
vi.mock('../persistDebugLog', () => ({ persistDebugLog }));

import type { WebContents } from 'electron';
import { handle, handleResult, sendEvent } from '../ipc';

type Registered = (event: unknown, ...args: unknown[]) => unknown;

function registered(channel: string): Registered {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`nothing registered for ${channel}`);
  return call[1] as Registered;
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear();
  persistDebugLog.mockClear();
});

describe('handle', () => {
  it('registers the handler as given, so a throw rejects the invoke', async () => {
    const handler = vi.fn(async (_event: unknown, payload: { projectId: string }) =>
      payload.projectId === 'p1' ? 2 : null
    );
    handle('hermes-projects:source-count', handler);
    const fn = registered('hermes-projects:source-count');
    await expect(fn({}, { projectId: 'p1' })).resolves.toBe(2);

    handler.mockRejectedValueOnce(new Error('sources.yaml unreadable'));
    await expect(fn({}, { projectId: 'p1' })).rejects.toThrow('sources.yaml unreadable');
  });
});

describe('handleResult', () => {
  it('passes the event and arguments through and returns the result', async () => {
    const handler = vi.fn(async () => ({ success: true }));
    handleResult('calendars:remove', handler);
    const event = { sender: { id: 3 } };
    await expect(registered('calendars:remove')(event, { slug: 'personal' })).resolves.toEqual({
      success: true,
    });
    expect(handler).toHaveBeenCalledWith(event, { slug: 'personal' });
  });

  it('keeps a failure the handler returns', async () => {
    handleResult('calendars:recheck', async () => ({ success: false, error: 'Sign-in failed.' }));
    await expect(registered('calendars:recheck')({}, { slug: 'personal' })).resolves.toEqual({
      success: false,
      error: 'Sign-in failed.',
    });
    expect(persistDebugLog).not.toHaveBeenCalled();
  });

  it('turns a thrown Error into a failure with its message', async () => {
    handleResult('hermes-projects:sources-reveal', async () => {
      throw new TypeError('Cannot read properties of undefined');
    });
    await expect(registered('hermes-projects:sources-reveal')({}, {})).resolves.toEqual({
      success: false,
      error: 'Cannot read properties of undefined',
    });
    expect(persistDebugLog).toHaveBeenCalledWith('ipc', 'handler threw', {
      channel: 'hermes-projects:sources-reveal',
      errorName: 'TypeError',
    });
  });

  it('turns a synchronous throw of a non-Error into a failure', async () => {
    handleResult('host-bridge:browser-open', () => {
      throw 'browser gone';
    });
    await expect(registered('host-bridge:browser-open')({})).resolves.toEqual({
      success: false,
      error: 'browser gone',
    });
  });

  it('never logs the arguments, which can carry a password', async () => {
    handleResult('calendars:connect', async () => {
      throw new Error('refused');
    });
    await registered('calendars:connect')({}, { password: 'abcd-efgh' });
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('abcd-efgh');
  });
});

describe('sendEvent', () => {
  function contents(destroyed: boolean) {
    return { isDestroyed: () => destroyed, send: vi.fn() };
  }

  it('sends the payload, or no argument for a void event', () => {
    const live = contents(false);
    sendEvent(live as unknown as WebContents, 'hermes-kanban:open-task', 't1');
    sendEvent(live as unknown as WebContents, 'hermes-chat:sessions-changed');
    expect(live.send.mock.calls).toEqual([['hermes-kanban:open-task', 't1'], ['hermes-chat:sessions-changed']]);
  });

  it('skips a destroyed webContents, which would throw', () => {
    const gone = contents(true);
    sendEvent(gone as unknown as WebContents, 'capability:progress', 'Pulling images');
    expect(gone.send).not.toHaveBeenCalled();
  });
});
