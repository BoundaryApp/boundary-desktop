import { describe, expect, it } from 'vitest';
import {
  formatDayLabel,
  formatMessageTime,
  formatMessageTimeFull,
  toUnixSeconds,
} from '../../../../shared/messageTime';
import { messageTimeMs, needsDayDivider } from '../messageMeta';
import { toThreadMessage } from '../chatHistoryMessages';

describe('messageTime', () => {
  it('coerces seconds, ms and date strings to unix seconds', () => {
    expect(toUnixSeconds(1767225600)).toBe(1767225600);
    expect(toUnixSeconds(1767225600000)).toBe(1767225600);
    expect(toUnixSeconds('1767225600')).toBe(1767225600);
    expect(toUnixSeconds('2026-01-01T00:00:00.000Z')).toBe(1767225600);
    expect(toUnixSeconds(null)).toBeNull();
    expect(toUnixSeconds('soon')).toBeNull();
    expect(toUnixSeconds(0)).toBeNull();
  });

  it('labels days relative to now', () => {
    const now = new Date(2026, 8, 29, 14, 0).getTime();
    expect(formatDayLabel(new Date(2026, 8, 29, 1, 0).getTime(), now, 'en-US')).toBe('Today');
    expect(formatDayLabel(new Date(2026, 8, 28, 23, 0).getTime(), now, 'en-US')).toBe(
      'Yesterday'
    );
    expect(formatDayLabel(new Date(2026, 8, 21, 9, 0).getTime(), now, 'en-US')).toBe(
      'Monday, September 21'
    );
    expect(formatDayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now, 'en-US')).toBe(
      'Wednesday, December 31, 2025'
    );
  });

  it('formats a short time and a full tooltip', () => {
    const ms = new Date(2026, 8, 29, 14, 14, 8).getTime();
    expect(formatMessageTime(ms, 'en-US')).toBe('2:14 PM');
    expect(formatMessageTimeFull(ms, 'en-US')).toBe(
      'Tuesday, September 29, 2026 at 2:14:08 PM'
    );
  });
});

describe('messageMeta', () => {
  it('prefers the stored time and never falls back to load time for history', () => {
    const loadedAt = new Date(2026, 8, 29, 9, 0);
    expect(messageTimeMs({ createdAt: loadedAt, metadata: { custom: { ts: 100 } } })).toBe(
      100_000
    );
    expect(messageTimeMs({ createdAt: loadedAt, metadata: { custom: { ts: null } } })).toBeNull();
    expect(messageTimeMs({ createdAt: loadedAt })).toBe(loadedAt.getTime());
    expect(messageTimeMs(undefined)).toBeNull();
  });

  it('puts a divider on the first timed message and at each new local day', () => {
    const mon = new Date(2026, 8, 28, 23, 0).getTime();
    const tue = new Date(2026, 8, 29, 1, 0).getTime();
    expect(needsDayDivider(0, tue, null)).toBe(true);
    expect(needsDayDivider(3, tue, mon)).toBe(true);
    expect(needsDayDivider(3, tue, tue + 60_000)).toBe(false);
    expect(needsDayDivider(3, tue, null)).toBe(false);
    expect(needsDayDivider(0, null, null)).toBe(false);
  });

  it('hydrates history rows with an explicit time slot', () => {
    expect(toThreadMessage({ role: 'user', content: 'hi', timestamp: 100, rowId: 7 }, 0)).toEqual({
      id: 'hist-0',
      role: 'user',
      content: 'hi',
      createdAt: new Date(100_000),
      metadata: { custom: { ts: 100, rowId: 7 } },
    });
    expect(toThreadMessage({ role: 'assistant', content: 'yo' }, 1)).toEqual({
      id: 'hist-1',
      role: 'assistant',
      content: 'yo',
      metadata: { custom: { ts: null, rowId: null } },
    });
  });

  it("carries a reply's writing voice from history", () => {
    expect(
      toThreadMessage({ role: 'assistant', content: 'yo', writingVoiceName: 'News' }, 2).metadata
    ).toEqual({ custom: { ts: null, rowId: null, writingVoiceName: 'News' } });
  });
});

