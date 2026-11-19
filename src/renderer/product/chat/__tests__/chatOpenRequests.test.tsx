import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestChatOpen, resetChatOpenRequestsForTests, useChatOpenRequests } from '../chatOpenRequests';

const commands = vi.hoisted(() => ({ dispatchAppCommand: vi.fn() }));
vi.mock('../../useAppShortcuts', () => commands);

afterEach(() => {
  resetChatOpenRequestsForTests();
  commands.dispatchAppCommand.mockReset();
});

describe('chat open requests (ADR 0058 §10)', () => {
  it('goes to Chat and hands the chat to the screen once it is there', () => {
    requestChatOpen('s-1');
    expect(commands.dispatchAppCommand).toHaveBeenCalledWith('go-chat');
    const handler = vi.fn();
    const { rerender } = renderHook(() => useChatOpenRequests(handler));
    expect(handler).toHaveBeenCalledWith('s-1');
    rerender();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hands over a request made while the screen is open, and the same chat asked twice', () => {
    const handler = vi.fn();
    renderHook(() => useChatOpenRequests(handler));
    act(() => requestChatOpen('s-1'));
    act(() => requestChatOpen('s-1'));
    expect(handler.mock.calls).toEqual([['s-1'], ['s-1']]);
  });

  it('only goes to Chat when no chat is named', () => {
    const handler = vi.fn();
    renderHook(() => useChatOpenRequests(handler));
    act(() => requestChatOpen(null));
    expect(commands.dispatchAppCommand).toHaveBeenCalledWith('go-chat');
    expect(handler).not.toHaveBeenCalled();
  });
});
