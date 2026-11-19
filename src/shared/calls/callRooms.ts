/**
 * Which rooms have a live call in each Circle, and who is in them, from `call.state` signals.
 * Each device is its own entry, keyed by its session, so one person on two Macs shows twice.
 * Nothing here reads a clock: callers pass `now`.
 */
import { Listeners } from './listeners';
import { CALL_GONE_MS, type CallState } from './callMessages';

export interface RoomPerson {
  identity: string;
  s: string;
  muted: boolean;
  camera: boolean;
  /** The device (64 hex) that sent the state, when known. */
  device?: string;
}

export interface LiveRoom {
  room: string;
  people: RoomPerson[];
}

interface Entry extends RoomPerson {
  room: string;
  seen: number;
}

export class CallRooms {
  /** Circle key → session → entry. */
  private circles = new Map<string, Map<string, Entry>>();
  private listeners = new Listeners();

  see(circleKey: string, from: string, state: CallState, now: number, device?: string): void {
    let sessions = this.circles.get(circleKey);
    const previous = sessions?.get(state.s);
    if (state.left) {
      if (!previous) return;
      sessions!.delete(state.s);
      this.changed();
      return;
    }
    if (!sessions) {
      sessions = new Map();
      this.circles.set(circleKey, sessions);
    }
    const entry: Entry = { identity: from, s: state.s, muted: state.muted, camera: state.camera, room: state.room, seen: now, ...(device ? { device } : {}) };
    sessions.set(state.s, entry);
    const same =
      previous &&
      previous.identity === entry.identity &&
      previous.room === entry.room &&
      previous.muted === entry.muted &&
      previous.camera === entry.camera &&
      previous.device === entry.device;
    if (!same) this.changed();
  }

  /** Forget sessions not heard from for `CALL_GONE_MS`. */
  expire(now: number): void {
    let dropped = false;
    for (const sessions of this.circles.values()) {
      for (const [s, entry] of sessions) {
        if (now - entry.seen >= CALL_GONE_MS) {
          sessions.delete(s);
          dropped = true;
        }
      }
    }
    if (dropped) this.changed();
  }

  rooms(circleKey: string): LiveRoom[] {
    const byRoom = new Map<string, RoomPerson[]>();
    for (const entry of this.circles.get(circleKey)?.values() ?? []) {
      const people = byRoom.get(entry.room) ?? [];
      people.push(person(entry));
      byRoom.set(entry.room, people);
    }
    return [...byRoom].map(([room, people]) => ({ room, people }));
  }

  people(circleKey: string, room: string): RoomPerson[] {
    return [...(this.circles.get(circleKey)?.values() ?? [])].filter((entry) => entry.room === room).map(person);
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private changed(): void {
    this.listeners.emit();
  }
}

function person({ identity, s, muted, camera, device }: Entry): RoomPerson {
  return { identity, s, muted, camera, ...(device ? { device } : {}) };
}
