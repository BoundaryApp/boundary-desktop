import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWritingCheck } from '../useWritingCheck';

const reply = { messageId: 'm1', markdown: 'I hope this helps!', source: 'Reply' };

describe('useWritingCheck', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('keeps a check with the chat it came from', () => {
    const { result, rerender } = renderHook(({ chat }) => useWritingCheck(chat), {
      initialProps: { chat: 'a' },
    });
    act(() => result.current.request(reply));
    expect(result.current.check).toMatchObject({ seq: 1, messageId: 'm1' });
    rerender({ chat: 'b' });
    expect(result.current.check).toBeNull();
    rerender({ chat: 'a' });
    expect(result.current.check?.seq).toBe(1);
    act(() => result.current.request({ ...reply, messageId: 'm2' }));
    expect(result.current.check).toMatchObject({ seq: 2, messageId: 'm2' });
    act(() => result.current.close());
    expect(result.current.check).toBeNull();
  });

  it('scrolls to the checked reply and marks it for a moment', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="wb-msg is-assistant" data-message-id="m:1"></div>';
    const row = document.querySelector<HTMLElement>('.wb-msg') as HTMLElement;
    const scrollIntoView = vi.fn();
    row.scrollIntoView = scrollIntoView;
    const { result } = renderHook(() => useWritingCheck('a'));

    act(() => result.current.showReply('m:1'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(row.classList.contains('is-focused')).toBe(true);
    act(() => vi.advanceTimersByTime(2400));
    expect(row.classList.contains('is-focused')).toBe(false);
  });
});
