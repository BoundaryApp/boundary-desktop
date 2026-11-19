import { describe, expect, it } from 'vitest';
import { CallRooms } from '../calls/callRooms';

const KEY = 'aa'.repeat(32);
const OTHER = 'cc'.repeat(32);
const MAYA = 'bb'.repeat(32);
const SAM = 'dd'.repeat(32);
const S1 = '1111111111111111';
const S2 = '2222222222222222';

const state = (room: string, s: string, extra: Partial<{ muted: boolean; camera: boolean; left: true }> = {}) => ({
  room,
  s,
  muted: false,
  camera: true,
  ...extra,
});

describe('CallRooms', () => {
  it("lists a room once someone's state arrives", () => {
    const rooms = new CallRooms();
    rooms.see(KEY, MAYA, state('channel/abc', S1), 0);
    expect(rooms.rooms(KEY)).toEqual([
      { room: 'channel/abc', people: [{ identity: MAYA, s: S1, muted: false, camera: true }] },
    ]);
    expect(rooms.people(KEY, 'channel/abc')).toHaveLength(1);
    expect(rooms.people(KEY, 'nowhere')).toEqual([]);
  });

  it('keeps two devices of one person apart', () => {
    const rooms = new CallRooms();
    rooms.see(KEY, MAYA, state('check', S1), 0);
    rooms.see(KEY, MAYA, state('check', S2), 0);
    expect(rooms.people(KEY, 'check').map((person) => person.s)).toEqual([S1, S2]);
  });

  it('moves a session that changes room', () => {
    const rooms = new CallRooms();
    rooms.see(KEY, MAYA, state('one', S1), 0);
    rooms.see(KEY, MAYA, state('two', S1), 1);
    expect(rooms.rooms(KEY).map((room) => room.room)).toEqual(['two']);
  });

  it('drops a session at once when it says it left', () => {
    const rooms = new CallRooms();
    rooms.see(KEY, MAYA, state('check', S1), 0);
    rooms.see(KEY, MAYA, state('check', S1, { left: true }), 1);
    expect(rooms.rooms(KEY)).toEqual([]);
  });

  it('drops a session 15 seconds after its last state', () => {
    const rooms = new CallRooms();
    rooms.see(KEY, MAYA, state('check', S1), 1_000);
    rooms.expire(1_000 + 14_999);
    expect(rooms.people(KEY, 'check')).toHaveLength(1);
    rooms.expire(1_000 + 15_000);
    expect(rooms.people(KEY, 'check')).toHaveLength(0);
  });

  it('notifies listeners on change but not on a repeat of the same state', () => {
    const rooms = new CallRooms();
    let changes = 0;
    const stop = rooms.onChange(() => changes++);
    rooms.see(KEY, MAYA, state('check', S1), 0);
    rooms.see(KEY, MAYA, state('check', S1), 5_000);
    expect(changes).toBe(1);
    rooms.see(KEY, MAYA, state('check', S1, { muted: true }), 6_000);
    expect(changes).toBe(2);
    rooms.expire(100_000);
    expect(changes).toBe(3);
    stop();
    rooms.see(KEY, MAYA, state('check', S1), 100_001);
    expect(changes).toBe(3);
  });

  it('keeps Circles apart', () => {
    const rooms = new CallRooms();
    rooms.see(KEY, MAYA, state('check', S1), 0);
    rooms.see(OTHER, SAM, state('check', S2), 0);
    expect(rooms.people(KEY, 'check').map((person) => person.identity)).toEqual([MAYA]);
    expect(rooms.people(OTHER, 'check').map((person) => person.identity)).toEqual([SAM]);
  });

  it('keeps the device a state came from', () => {
    const rooms = new CallRooms();
    const device = 'd4'.repeat(32);
    rooms.see(KEY, MAYA, state('check', S1), 0, device);
    rooms.see(KEY, SAM, state('check', S2), 0);
    expect(rooms.people(KEY, 'check')).toEqual([
      { identity: MAYA, s: S1, muted: false, camera: true, device },
      { identity: SAM, s: S2, muted: false, camera: true },
    ]);
  });
});
