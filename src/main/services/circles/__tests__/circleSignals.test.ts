import { describe, expect, it } from 'vitest';
import {
  decodeSignal,
  encodeSignal,
  MAX_SIGNAL_FRAME_BYTES,
  MAX_SIGNAL_PAYLOAD_BYTES,
  SignalRate,
  SignalStats,
} from '../circleSignals';

const circle = 'ab'.repeat(32);

describe('signal frames', () => {
  it('round-trips the largest payload with the longest topic', () => {
    const frame = { circle, topic: 't'.repeat(64), payload: 'x'.repeat(MAX_SIGNAL_PAYLOAD_BYTES - 2) };
    const raw = encodeSignal(frame);
    expect(raw.length).toBeLessThanOrEqual(MAX_SIGNAL_FRAME_BYTES);
    expect(decodeSignal(raw)).toEqual(frame);
  });

  it('counts a payload in bytes, not characters', () => {
    expect(() => encodeSignal({ circle, topic: 'a', payload: 'é'.repeat(MAX_SIGNAL_PAYLOAD_BYTES / 2) })).toThrow(/too long/);
  });

  it('refuses to encode a payload that isn’t JSON', () => {
    expect(() => encodeSignal({ circle, topic: 'a', payload: undefined })).toThrow(/JSON/);
  });

  it.each([
    ['not JSON', Buffer.from('{')],
    ['null', Buffer.from('null')],
    ['a bad Circle key', Buffer.from(JSON.stringify({ circle: 'abc', topic: 'a', payload: 1 }))],
    ['a bad topic', Buffer.from(JSON.stringify({ circle, topic: '../a', payload: 1 }))],
    ['no payload', Buffer.from(JSON.stringify({ circle, topic: 'a' }))],
    ['too many bytes', Buffer.from(JSON.stringify({ circle, topic: 'a', payload: 'x'.repeat(MAX_SIGNAL_FRAME_BYTES) }))],
  ])('drops a frame with %s', (_name, raw) => {
    expect(decodeSignal(raw)).toBeNull();
  });
});

describe('SignalRate', () => {
  it('allows the burst, then refills at the rate and no higher than the burst', () => {
    const rate = new SignalRate({ perSecond: 10, burst: 3 }, 0);
    expect([rate.take(0), rate.take(0), rate.take(0), rate.take(0)]).toEqual([true, true, true, false]);
    expect(rate.take(99)).toBe(false);
    expect(rate.take(100)).toBe(true);
    const taken = [60_000, 60_000, 60_000, 60_000].map((now) => rate.take(now));
    expect(taken).toEqual([true, true, true, false]);
  });
});

describe('SignalStats', () => {
  it('adds up by topic and by drop reason', () => {
    const stats = new SignalStats();
    stats.onSent('typing', 10);
    stats.onSent('typing', 5);
    stats.onReceived('read', 7);
    stats.onDropped('rate');
    stats.onDropped('rate');
    expect(stats.summary()).toEqual({
      sent: { typing: { messages: 2, bytes: 15 } },
      received: { read: { messages: 1, bytes: 7 } },
      dropped: { rate: 2 },
    });
  });
});
