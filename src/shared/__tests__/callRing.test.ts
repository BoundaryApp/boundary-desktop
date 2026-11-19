import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_ANSWERING_MS,
  CALL_RING_EVERY_MS,
  CALL_RING_GONE_MS,
  CALL_RING_MS,
  Dialer,
  RingInbox,
  cleanCallRing,
  newPersonRoom,
  type CallRingMessage,
} from '../calls/callRing';

const ROOM = 'person/0123456789abcdef';
const OTHER = 'person/1111111111111111';
const THIRD = 'person/2222222222222222';

describe('Dialer', () => {
  let sent: CallRingMessage[];
  let dialer: Dialer;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    dialer = new Dialer({ room: ROOM, to: 'bob', send: (m) => sent.push(m) });
  });
  afterEach(() => {
    dialer.stop();
    vi.useRealTimers();
  });

  it('rings at once and every 5 seconds', () => {
    dialer.start();
    expect(sent).toEqual([{ t: 'ring', room: ROOM }]);
    vi.advanceTimersByTime(CALL_RING_EVERY_MS);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(CALL_RING_EVERY_MS);
    expect(sent).toHaveLength(3);
    expect(dialer.status).toBe('calling');
  });

  it('gives up after 30 seconds with no answer and cancels', () => {
    const changes = vi.fn();
    dialer.onChange(changes);
    dialer.start();
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(dialer.status).toBe('no-answer');
    expect(sent.at(-1)).toEqual({ t: 'cancel', room: ROOM });
    expect(changes).toHaveBeenCalled();
    const count = sent.length;
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(sent).toHaveLength(count);
  });

  it('waits up to 60 seconds after answering', () => {
    dialer.start();
    vi.advanceTimersByTime(10_000);
    dialer.receive('bob', { t: 'answering', room: ROOM });
    const count = sent.length;
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(dialer.status).toBe('calling');
    expect(sent).toHaveLength(count);
    vi.advanceTimersByTime(CALL_ANSWERING_MS - CALL_RING_MS);
    expect(dialer.status).toBe('no-answer');
  });

  it('stops when the person arrives', () => {
    dialer.start();
    dialer.arrived();
    expect(dialer.status).toBe('answered');
    const count = sent.length;
    vi.advanceTimersByTime(CALL_ANSWERING_MS * 2);
    expect(sent).toHaveLength(count);
    expect(dialer.status).toBe('answered');
  });

  it('turns declined and busy into a status and cancels', () => {
    dialer.start();
    dialer.receive('bob', { t: 'decline', room: ROOM });
    expect(dialer.status).toBe('declined');
    expect(sent.at(-1)).toEqual({ t: 'cancel', room: ROOM });

    const other: CallRingMessage[] = [];
    const busy = new Dialer({ room: ROOM, to: 'bob', send: (m) => other.push(m) });
    busy.start();
    busy.receive('bob', { t: 'busy', room: ROOM });
    expect(busy.status).toBe('busy');
    expect(other.at(-1)).toEqual({ t: 'cancel', room: ROOM });
    const count = other.length;
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(other).toHaveLength(count);
  });

  it('ignores other people and other rooms', () => {
    dialer.start();
    dialer.receive('carol', { t: 'decline', room: ROOM });
    dialer.receive('bob', { t: 'decline', room: 'person/ffffffffffffffff' });
    expect(dialer.status).toBe('calling');
  });

  it('stop while calling cancels', () => {
    dialer.start();
    dialer.stop();
    expect(sent.at(-1)).toEqual({ t: 'cancel', room: ROOM });
    const count = sent.length;
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(sent).toHaveLength(count);
  });

  it('after stop, a late decline or busy sends nothing and changes nothing', () => {
    const changes = vi.fn();
    dialer.onChange(changes);
    dialer.start();
    dialer.stop();
    const count = sent.length;
    dialer.receive('bob', { t: 'decline', room: ROOM });
    dialer.receive('bob', { t: 'busy', room: ROOM });
    dialer.arrived();
    expect(sent).toHaveLength(count);
    expect(changes).not.toHaveBeenCalled();
    expect(dialer.status).toBe('calling');
  });

  it('only the first answering starts the 60-second wait', () => {
    dialer.start();
    dialer.receive('bob', { t: 'answering', room: ROOM });
    vi.advanceTimersByTime(50_000);
    dialer.receive('bob', { t: 'answering', room: ROOM });
    vi.advanceTimersByTime(CALL_ANSWERING_MS - 50_000);
    expect(dialer.status).toBe('no-answer');
  });
});

describe('RingInbox', () => {
  const ring = (inbox: RingInbox, now: number, from = 'alice') =>
    inbox.receive('circle', from, { t: 'ring', room: ROOM }, now);

  it('keeps one ring per room and its first time', () => {
    const inbox = new RingInbox();
    ring(inbox, 1000);
    ring(inbox, 6000);
    expect(inbox.rings).toEqual([{ circleKey: 'circle', from: 'alice', room: ROOM, since: 1000 }]);
  });

  it('drops a ring 12 seconds after the last repeat', () => {
    const inbox = new RingInbox();
    ring(inbox, 0);
    ring(inbox, 5000);
    inbox.expire(5000 + CALL_RING_GONE_MS - 1);
    expect(inbox.rings).toHaveLength(1);
    inbox.expire(5000 + CALL_RING_GONE_MS);
    expect(inbox.rings).toHaveLength(0);
  });

  it('drops a ring 30 seconds after it started however often it repeats', () => {
    const inbox = new RingInbox();
    for (let t = 0; t <= 30_000; t += 5000) ring(inbox, t);
    inbox.expire(CALL_RING_MS - 1);
    expect(inbox.rings).toHaveLength(1);
    inbox.expire(CALL_RING_MS);
    expect(inbox.rings).toHaveLength(0);
  });

  it('drops a cancelled, present or dismissed ring', () => {
    const inbox = new RingInbox();
    const changes = vi.fn();
    inbox.onChange(changes);
    ring(inbox, 0);
    inbox.receive('circle', 'alice', { t: 'cancel', room: ROOM }, 1);
    expect(inbox.rings).toHaveLength(0);
    inbox.receive('circle', 'alice', { t: 'ring', room: OTHER }, 2);
    inbox.present('circle', 'alice', OTHER);
    expect(inbox.rings).toHaveLength(0);
    inbox.receive('circle', 'alice', { t: 'ring', room: THIRD }, 3);
    inbox.dismiss(THIRD);
    expect(inbox.rings).toHaveLength(0);
    expect(changes).toHaveBeenCalled();
  });

  it('a late repeat does not bring back a cancelled, present or dismissed ring', () => {
    const inbox = new RingInbox();
    for (const [room, drop] of [
      [ROOM, () => inbox.receive('circle', 'alice', { t: 'cancel', room: ROOM }, 1)],
      [OTHER, () => inbox.present('circle', 'alice', OTHER)],
      [THIRD, () => inbox.dismiss(THIRD)],
    ] as const) {
      inbox.receive('circle', 'alice', { t: 'ring', room }, 0);
      drop();
      inbox.receive('circle', 'alice', { t: 'ring', room }, 5000);
      inbox.receive('circle', 'alice', { t: 'ring', room }, CALL_RING_MS - 1);
    }
    expect(inbox.rings).toEqual([]);
  });

  it('forgets a dropped room 30 seconds after its ring started', () => {
    const inbox = new RingInbox();
    ring(inbox, 0);
    inbox.dismiss(ROOM);
    inbox.expire(CALL_RING_MS);
    ring(inbox, CALL_RING_MS);
    expect(inbox.rings).toEqual([{ circleKey: 'circle', from: 'alice', room: ROOM, since: CALL_RING_MS }]);
  });

  it('an answered ring leaves the cards but stays tracked until cancelled', () => {
    const inbox = new RingInbox();
    const changes = vi.fn();
    inbox.onChange(changes);
    ring(inbox, 0);
    inbox.answer(ROOM, 1000);
    expect(inbox.rings).toEqual([]);
    expect(inbox.answering).toEqual([{ circleKey: 'circle', from: 'alice', room: ROOM, since: 0 }]);
    expect(changes).toHaveBeenCalledTimes(2);
    // The caller stops repeating once told; that doesn't end it.
    inbox.expire(CALL_RING_MS + 1000);
    expect(inbox.answering).toHaveLength(1);
    // A repeat doesn't bring it back to the cards.
    ring(inbox, 2000);
    expect(inbox.rings).toEqual([]);
    inbox.receive('circle', 'alice', { t: 'cancel', room: ROOM }, 3000);
    expect(inbox.answering).toEqual([]);
    ring(inbox, 4000);
    expect(inbox.rings).toEqual([]);
  });

  it('an answered ring ends 60 seconds after answering', () => {
    const inbox = new RingInbox();
    ring(inbox, 0);
    inbox.answer(ROOM, 1000);
    inbox.expire(1000 + CALL_ANSWERING_MS - 1);
    expect(inbox.answering).toHaveLength(1);
    inbox.expire(1000 + CALL_ANSWERING_MS);
    expect(inbox.answering).toEqual([]);
  });

  it('an answered ring ends when dismissed, when the caller has someone, or when its Circle goes', () => {
    const inbox = new RingInbox();
    for (const room of [ROOM, OTHER, THIRD]) {
      inbox.receive('circle', 'alice', { t: 'ring', room }, 0);
      inbox.answer(room, 1);
    }
    inbox.dismiss(ROOM);
    inbox.present('circle', 'alice', OTHER);
    expect(inbox.answering).toEqual([expect.objectContaining({ room: THIRD })]);
    inbox.keepCircles(new Set(['elsewhere']));
    expect(inbox.answering).toEqual([]);
  });

  it('answering a room that is not ringing does nothing', () => {
    const inbox = new RingInbox();
    const changes = vi.fn();
    inbox.onChange(changes);
    inbox.answer(ROOM, 0);
    expect(inbox.answering).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });

  it('a repeat from another sender or Circle does not keep a ring alive', () => {
    const inbox = new RingInbox();
    ring(inbox, 0);
    ring(inbox, 5000, 'mallory');
    inbox.receive('elsewhere', 'alice', { t: 'ring', room: ROOM }, 10_000);
    inbox.expire(CALL_RING_GONE_MS);
    expect(inbox.rings).toEqual([]);
  });
});

describe('cleanCallRing', () => {
  it('drops a room without person/ and unknown kinds', () => {
    expect(cleanCallRing({ t: 'ring', room: ROOM })).toEqual({ t: 'ring', room: ROOM });
    expect(cleanCallRing({ t: 'ring', room: 'lobby', extra: 1 })).toBeNull();
    expect(cleanCallRing({ t: 'shout', room: ROOM })).toBeNull();
    expect(cleanCallRing(null)).toBeNull();
    expect(cleanCallRing({ t: 'busy', room: 'person/BAD' })).toBeNull();
  });

  it('makes person rooms that it accepts', () => {
    const room = newPersonRoom();
    expect(room).toMatch(/^person\/[0-9a-f]{16}$/);
    expect(cleanCallRing({ t: 'ring', room })).not.toBeNull();
  });
});
