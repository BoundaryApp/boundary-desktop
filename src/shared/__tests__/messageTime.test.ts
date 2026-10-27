import { describe, expect, it } from 'vitest';
import {
  formatDayAndTime,
  formatMessageTime,
  formatRowTime,
  formatShortDate,
  toIsoTimestamp,
} from '../messageTime';

const now = new Date(2026, 8, 29, 15, 0).getTime();
const today = new Date(2026, 8, 29, 14, 2).getTime();
const yesterday = new Date(2026, 8, 28, 9, 30).getTime();
const earlier = new Date(2026, 8, 22, 9, 0).getTime();
const lastYear = new Date(2025, 11, 3, 9, 0).getTime();

describe('formatShortDate', () => {
  it('adds the year only when it is not this year', () => {
    expect(formatShortDate(earlier, now, 'en-US')).toBe('Sep 22');
    expect(formatShortDate(lastYear, now, 'en-US')).toBe('Dec 3, 2025');
  });

  it('is empty for a missing date', () => {
    expect(formatShortDate(Date.parse(''), now)).toBe('');
  });
});

describe('formatRowTime', () => {
  it('shows the time for today and yesterday and the date before that', () => {
    expect(formatRowTime(today, now, 'en-US')).toBe(formatMessageTime(today, 'en-US'));
    expect(formatRowTime(yesterday, now, 'en-US')).toBe(formatMessageTime(yesterday, 'en-US'));
    expect(formatRowTime(earlier, now, 'en-US')).toBe('Sep 22');
    expect(formatRowTime(Number.NaN, now)).toBe('');
  });
});

describe('formatDayAndTime', () => {
  it('pairs Today and Yesterday with the time and shows the day label otherwise', () => {
    expect(formatDayAndTime(today, now, 'en-US')).toBe(`Today ${formatMessageTime(today, 'en-US')}`);
    expect(formatDayAndTime(yesterday, now, 'en-US')).toBe(
      `Yesterday ${formatMessageTime(yesterday, 'en-US')}`
    );
    expect(formatDayAndTime(earlier, now, 'en-US')).toBe('Tuesday, September 22');
    expect(formatDayAndTime(Number.NaN, now)).toBe('');
  });
});

describe('toIsoTimestamp', () => {
  it('reads seconds, milliseconds, numeric strings and date strings', () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIsoTimestamp(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(toIsoTimestamp('1700000000')).toBe('2023-11-14T22:13:20.000Z');
    expect(toIsoTimestamp('2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00.000Z');
  });

  // WebUI's old parser sent numeric strings at or below 1e9 to Date.parse and kept 0.
  it('takes every numeric string as seconds and drops 0 or less', () => {
    expect(toIsoTimestamp('86400')).toBe('1970-01-02T00:00:00.000Z');
    expect(toIsoTimestamp(0)).toBeUndefined();
    expect(toIsoTimestamp('')).toBeUndefined();
    expect(toIsoTimestamp('not a date')).toBeUndefined();
  });
});
