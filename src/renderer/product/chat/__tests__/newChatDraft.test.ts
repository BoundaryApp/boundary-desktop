import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchAppCommand } from '../../useAppShortcuts';
import { startNewChatWithDraft, takeNewChatDraft } from '../newChatDraft';

vi.mock('../../useAppShortcuts', () => ({ dispatchAppCommand: vi.fn() }));

describe('newChatDraft', () => {
  beforeEach(() => {
    takeNewChatDraft();
    vi.mocked(dispatchAppCommand).mockClear();
  });

  it('stores the text and asks for a new chat', () => {
    startNewChatWithDraft('hello');
    expect(dispatchAppCommand).toHaveBeenCalledWith('new-chat');
    expect(takeNewChatDraft()).toBe('hello');
  });

  it('hands the text over once', () => {
    startNewChatWithDraft('hello');
    takeNewChatDraft();
    expect(takeNewChatDraft()).toBeNull();
  });

  it('returns null when nothing was stored', () => {
    expect(takeNewChatDraft()).toBeNull();
  });
});
