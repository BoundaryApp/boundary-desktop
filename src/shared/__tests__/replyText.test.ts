import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPLY_TEXT,
  describeReplyText,
  isDefaultReplyText,
  normalizeReplyText,
} from '../replyText';

describe('normalizeReplyText', () => {
  it('fills anything missing or unreadable with the default', () => {
    expect(normalizeReplyText(undefined)).toEqual(DEFAULT_REPLY_TEXT);
    expect(normalizeReplyText('serif')).toEqual(DEFAULT_REPLY_TEXT);
    expect(normalizeReplyText({ face: 'mono', size: 'big', lineHeight: Number.NaN })).toEqual(DEFAULT_REPLY_TEXT);
  });

  it('keeps valid values and drops unknown fields', () => {
    const value = normalizeReplyText({ face: 'sans', size: 15, weight: 430, extra: true });
    expect(value).toEqual({ ...DEFAULT_REPLY_TEXT, face: 'sans', size: 15, weight: 430 });
  });

  it('clamps to the slider range and snaps to its step', () => {
    const value = normalizeReplyText({ size: 40, lineHeight: 1.0, listGap: 0.33, weight: 455 });
    expect(value.size).toBe(18);
    expect(value.lineHeight).toBe(1.4);
    expect(value.listGap).toBe(0.35);
    expect(value.weight).toBe(460);
  });

  it('returns step values without float noise', () => {
    expect(normalizeReplyText({ lineHeight: 1.7 }).lineHeight).toBe(1.7);
    expect(normalizeReplyText({ paragraphGap: 1.1 }).paragraphGap).toBe(1.1);
  });
});

describe('reply text summaries', () => {
  it('names the face, size and line height', () => {
    expect(describeReplyText(DEFAULT_REPLY_TEXT)).toBe('Serif · 15.5px · line height 1.7');
    expect(isDefaultReplyText(DEFAULT_REPLY_TEXT)).toBe(true);
    expect(isDefaultReplyText({ ...DEFAULT_REPLY_TEXT, listGap: 0.4 })).toBe(false);
  });
});
