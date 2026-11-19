import { describe, expect, it } from 'vitest';
import { repliesToMe, replyQuoteText } from '../circleReplies';
import type { CircleMessage } from '../types/circles';

type Original = Pick<CircleMessage, 'text' | 'call' | 'deleted'>;

const original = (text: string, extra: Partial<Original> = {}): Original => ({
  text,
  call: null,
  deleted: null,
  ...extra,
});

describe('replyQuoteText', () => {
  it('removes Markdown and keeps the first line', () => {
    expect(replyQuoteText(original('**Chapter 3** is `long`\nsecond line'))).toEqual({ state: 'found', text: 'Chapter 3 is long' });
    expect(replyQuoteText(original('\n\n# Picks\n- one'))).toEqual({ state: 'found', text: 'Picks' });
  });

  it('cuts past 120 characters with an ellipsis', () => {
    const long = 'a'.repeat(130);
    expect(replyQuoteText(original(long)).text).toBe(`${'a'.repeat(120)}…`);
    expect(replyQuoteText(original('a'.repeat(120))).text).toBe('a'.repeat(120));
  });

  it('shows a call as Call', () => {
    expect(replyQuoteText(original('', { call: { id: 'ab'.repeat(8) } }))).toEqual({ state: 'found', text: 'Call' });
  });

  it('says when the original is deleted or missing', () => {
    expect(replyQuoteText(original('', { deleted: 'author' }))).toEqual({ state: 'deleted', text: 'Original message deleted' });
    expect(replyQuoteText(original('', { deleted: 'admin' }))).toEqual({ state: 'deleted', text: 'Original message deleted' });
    expect(replyQuoteText(null)).toEqual({ state: 'missing', text: 'Original message not available' });
  });
});

describe('repliesToMe', () => {
  const ME = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const ref = (author: string) => ({ author, id: 'c'.repeat(16) });

  it('is true for someone else’s reply to me', () => {
    expect(repliesToMe({ author: OTHER, reply: ref(ME) }, ME)).toBe(true);
  });

  it('is false for my own reply, a reply to someone else, or no reply', () => {
    expect(repliesToMe({ author: ME, reply: ref(ME) }, ME)).toBe(false);
    expect(repliesToMe({ author: OTHER, reply: ref(OTHER) }, ME)).toBe(false);
    expect(repliesToMe({ author: OTHER, reply: null }, ME)).toBe(false);
  });
});
