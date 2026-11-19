import { describe, expect, it } from 'vitest';
import { cleanCallMessage, cleanCallState, isCallRoom } from '../calls/callMessages';

const S1 = '0123456789abcdef';
const S2 = 'fedcba9876543210';

describe('call messages', () => {
  it('accepts a state and a message of the right shape', () => {
    expect(cleanCallState({ room: 'channel/abc', s: S1, muted: false, camera: true })).toEqual({
      room: 'channel/abc',
      s: S1,
      muted: false,
      camera: true,
    });
    expect(cleanCallState({ room: 'check', s: S1, muted: true, camera: false, left: true })).toEqual({
      room: 'check',
      s: S1,
      muted: true,
      camera: false,
      left: true,
    });
    expect(cleanCallMessage({ t: 'offer', room: 'check', s: S1, to: S2, sdp: 'v=0', tunnel: 42 })).toEqual({
      t: 'offer',
      room: 'check',
      s: S1,
      to: S2,
      sdp: 'v=0',
      tunnel: 42,
    });
    expect(cleanCallMessage({ t: 'answer', room: 'check', s: S2, to: S1, sdp: 'v=0' })).toEqual({
      t: 'answer',
      room: 'check',
      s: S2,
      to: S1,
      sdp: 'v=0',
    });
    expect(cleanCallMessage({ t: 'bye', room: 'check', s: S2, to: S1 })).toEqual({ t: 'bye', room: 'check', s: S2, to: S1 });
  });

  it('drops a room with capitals, spaces or 65 characters', () => {
    expect(isCallRoom('channel/abc')).toBe(true);
    expect(isCallRoom('Channel')).toBe(false);
    expect(isCallRoom('a room')).toBe(false);
    expect(isCallRoom('a'.repeat(64))).toBe(true);
    expect(isCallRoom('a'.repeat(65))).toBe(false);
    expect(isCallRoom('/leading')).toBe(false);
    expect(cleanCallState({ room: 'Bad Room', s: S1, muted: false, camera: false })).toBeNull();
  });

  it("drops a session that isn't 16 hex", () => {
    expect(cleanCallState({ room: 'check', s: 'abc', muted: false, camera: false })).toBeNull();
    expect(cleanCallMessage({ t: 'bye', room: 'check', s: S1, to: 'XYZ' })).toBeNull();
  });

  it('drops an offer whose tunnel is 0 or not an integer, or whose description is too long', () => {
    expect(cleanCallMessage({ t: 'offer', room: 'check', s: S1, to: S2, sdp: 'v=0', tunnel: 0 })).toBeNull();
    expect(cleanCallMessage({ t: 'offer', room: 'check', s: S1, to: S2, sdp: 'v=0', tunnel: 1.5 })).toBeNull();
    expect(cleanCallMessage({ t: 'offer', room: 'check', s: S1, to: S2, sdp: 'v=0', tunnel: 0x1000000 })).toBeNull();
    expect(cleanCallMessage({ t: 'offer', room: 'check', s: S1, to: S2, sdp: 'x'.repeat(65_537) })).toBeNull();
    expect(cleanCallMessage({ t: 'offer', room: 'check', s: S1, to: S2, sdp: '' })).toBeNull();
  });

  it('drops extra fields and unknown kinds', () => {
    expect(cleanCallState({ room: 'check', s: S1, muted: false, camera: false, extra: 1, left: false })).toEqual({
      room: 'check',
      s: S1,
      muted: false,
      camera: false,
    });
    expect(cleanCallMessage({ t: 'bye', room: 'check', s: S1, to: S2, sdp: 'v=0' })).toEqual({ t: 'bye', room: 'check', s: S1, to: S2 });
    expect(cleanCallMessage({ t: 'ring', room: 'check', s: S1, to: S2 })).toBeNull();
    expect(cleanCallState(null)).toBeNull();
    expect(cleanCallState({ room: 'check', s: S1, muted: 'no', camera: false })).toBeNull();
  });

  it('drops peers that are negative, fractional or over 64', () => {
    const base = { room: 'check', s: S1, muted: false, camera: false };
    expect(cleanCallState({ ...base, peers: 2 })).toEqual({ ...base, peers: 2 });
    expect(cleanCallState({ ...base, peers: 64 })).toEqual({ ...base, peers: 64 });
    for (const peers of [-1, 1.5, 65, '1', NaN]) expect(cleanCallState({ ...base, peers })).toEqual(base);
  });
});
