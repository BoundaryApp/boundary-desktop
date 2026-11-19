// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircleChatUpdate, CircleMessage } from '../../../../shared/types/circles';
import { useCircleChat } from '../useCircleChat';

const KEY = 'cc'.repeat(32);
const ME = 'aa'.repeat(32);
const MAYA = 'bb'.repeat(32);

const message = (id: string, extra: Partial<CircleMessage> = {}): CircleMessage => ({
  circleKey: KEY,
  channel: 'general',
  author: ME,
  id,
  name: 'Ada',
  agent: null,
  text: 'hello',
  at: 1_000,
  confirmed: true,
  edited: false,
  deleted: null,
  shared: null,
  call: null,
  mentions: null,
  reply: null,
  reactions: [],
  mine: true,
  ...extra,
});

const reaction = (identity: string, at: number): CircleMessage['reactions'] => [
  { emoji: '👍', count: 1, mine: identity === ME, people: [{ identity, name: 'Maya', left: false, at }] },
];

describe('useCircleChat reactions', () => {
  let emit: (update: CircleChatUpdate) => void = () => undefined;
  const circles = {
    chatMessages: vi.fn(),
    chatPost: vi.fn(async (): Promise<{ success: boolean; id?: string }> => ({ success: true, id: '0009' })),
    chatReact: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
    chatRead: vi.fn(async () => ({ success: true })),
    onChatEvent: vi.fn((listener: (update: CircleChatUpdate) => void): (() => void) => {
      emit = listener;
      return () => undefined;
    }),
    onChatPresence: vi.fn((): (() => void) => () => undefined),
  };
  const update = (changed: CircleMessage[]): CircleChatUpdate => ({ circleKey: KEY, channel: 'general', added: [], changed, gone: [] });

  beforeEach(() => {
    circles.chatMessages.mockResolvedValue({ success: true, messages: [message('0001'), message('0002', { author: MAYA, mine: false })], more: false });
    (window as unknown as { electronAPI: unknown }).electronAPI = { circles };
  });
  afterEach(() => vi.clearAllMocks());

  it('react calls chatReact with the message and emoji', async () => {
    const { result } = renderHook(() => useCircleChat(KEY, 'general'));
    expect(await result.current.react({ author: ME, id: '0001' }, '👍', true)).toBeNull();
    expect(circles.chatReact).toHaveBeenLastCalledWith({ key: KEY, channel: 'general', author: ME, id: '0001', emoji: '👍', on: true });
    circles.chatReact.mockResolvedValueOnce({ success: false, error: 'Not a member' });
    expect(await result.current.react({ author: ME, id: '0001' }, '👍', false)).toBe('Not a member');
  });

  it('send passes a reply to chatPost and leaves it out when absent', async () => {
    const { result } = renderHook(() => useCircleChat(KEY, 'general'));
    const ref = { author: MAYA, id: '0002' };
    expect(await result.current.send('hi', [], false, ref)).toBeNull();
    expect(circles.chatPost).toHaveBeenLastCalledWith({ key: KEY, channel: 'general', text: 'hi', picked: [], mentionChannel: false, reply: ref });
    await result.current.send('again');
    expect(circles.chatPost).toHaveBeenLastCalledWith({ key: KEY, channel: 'general', text: 'again' });
  });

  it('a new reaction on my message re-marks the open channel read, once per change', async () => {
    const { result } = renderHook(() => useCircleChat(KEY, 'general'));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    const newest = () => result.current.messages.at(-1) as CircleMessage;
    act(() => result.current.markRead(newest()));
    act(() => result.current.markRead(newest()));
    expect(circles.chatRead).toHaveBeenCalledTimes(1);

    const reacted = message('0001', { reactions: reaction(MAYA, 5_000) });
    act(() => emit(update([reacted])));
    expect(result.current.seen).toBe(5_000);
    act(() => result.current.markRead(newest()));
    expect(circles.chatRead).toHaveBeenCalledTimes(2);

    act(() => emit(update([reacted])));
    act(() => result.current.markRead(newest()));
    expect(circles.chatRead).toHaveBeenCalledTimes(2);
  });

  it('takes seen from a reacted message a chat event reports, even when it isn’t loaded, until the channel changes', async () => {
    const { result, rerender } = renderHook(({ channel }) => useCircleChat(KEY, channel), { initialProps: { channel: 'general' } });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    act(() => emit(update([message('00aa', { reactions: reaction(MAYA, 7_000) })])));
    expect(result.current.seen).toBe(7_000);
    expect(result.current.messages.some((m) => m.id === '00aa')).toBe(false);
    rerender({ channel: 'garden' });
    expect(result.current.seen).toBe(0);
  });

  it('my own reaction, or one on someone else’s message, does not change seen', async () => {
    const { result } = renderHook(() => useCircleChat(KEY, 'general'));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    act(() => emit(update([message('0001', { reactions: reaction(ME, 9_000) })])));
    act(() => emit(update([message('0002', { author: MAYA, mine: false, reactions: reaction(MAYA, 9_000) })])));
    expect(result.current.seen).toBe(0);
  });
});
