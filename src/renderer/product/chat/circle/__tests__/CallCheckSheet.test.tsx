import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { circleMember, circleSnapshot } from '../../../../__tests__/circleFixtures';
import type { Call } from '../../../circles/calls/callService';
import type { CallCheck } from '../../../circles/callCheck';
import { CallCheckSheet } from '../CallCheckSheet';

const KEY = 'cc'.repeat(32);
const ME = 'a1'.repeat(32);
const MAYA = 'b2'.repeat(32);

const hook = vi.hoisted(() => ({
  call: null as Call | null,
  join: vi.fn(),
}));
const service = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock('../../../circles/calls/useCircleCall', () => ({
  useCircleCall: () => ({ rooms: [] as unknown[], call: hook.call, join: hook.join }),
}));
vi.mock('../../../circles/calls/callService', () => ({ getCallService: () => service }));

function fakeCall(): Call {
  return {
    circleKey: KEY,
    room: 'check',
    me: ME,
    with: null,
    dial: null,
    connectedAt: null,
    participants: [],
    localStream: new MediaStream(),
    muted: false,
    camera: true,
    mute: vi.fn(),
    setCamera: vi.fn(async () => undefined),
    setDevice: vi.fn(async () => undefined),
    retry: vi.fn(),
    leave: vi.fn(() => {
      hook.call = null;
    }),
    onChange: () => (): void => undefined,
  };
}

const check = { results: [], onResult: () => (): void => undefined } as unknown as CallCheck;
const circle = circleSnapshot({
  key: KEY,
  members: [
    circleMember({ identity: ME, name: 'Ada', isMe: true, online: true }),
    circleMember({ identity: MAYA, name: 'Maya', online: true }),
  ],
});

describe('CallCheckSheet test call', () => {
  beforeEach(() => {
    hook.call = null;
    hook.join.mockReset();
    service.cancel.mockReset();
    hook.join.mockImplementation(async () => {
      hook.call = fakeCall();
      return hook.call;
    });
  });
  afterEach(cleanup);

  it('the sheet joins the test call room and shows the stage', async () => {
    const { rerender } = render(<CallCheckSheet check={check} circle={circle} open onClose={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Join test call' }));
    });
    expect(hook.join).toHaveBeenCalledWith('check', { audio: true, video: true });
    rerender(<CallCheckSheet check={check} circle={circle} open onClose={() => undefined} />);
    expect(screen.getByRole('list', { name: 'Call' })).toBeTruthy();
    const call = hook.call!;
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(call.leave).toHaveBeenCalled();
  });

  it('closing the sheet leaves the test call', () => {
    hook.call = fakeCall();
    const call = hook.call;
    const { unmount } = render(<CallCheckSheet check={check} circle={circle} open onClose={() => undefined} />);
    unmount();
    expect(call.leave).toHaveBeenCalled();
  });

  it('closing the sheet while joining cancels the join', async () => {
    hook.join.mockImplementation(() => new Promise(() => undefined));
    const { unmount } = render(<CallCheckSheet check={check} circle={circle} open onClose={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Join test call' }));
    });
    unmount();
    expect(service.cancel).toHaveBeenCalled();
  });
});
