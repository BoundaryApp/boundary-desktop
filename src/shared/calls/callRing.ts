/**
 * Ringing for calls with one person. A caller sends `ring` to one member's identity on the
 * `call.ring` signal topic every few seconds; the callee's devices answer with `answering`,
 * `decline` or `busy`. Messages are untrusted until cleaned here.
 */
import { isCallRoom } from './callMessages';
import { Listeners } from './listeners';

/** The signal topic for rings. */
export const CALL_RING_TOPIC = 'call.ring';
/** How long a call rings before the caller gives up. */
export const CALL_RING_MS = 30_000;
/** How often the caller repeats `ring`. */
export const CALL_RING_EVERY_MS = 5_000;
/** A ring that hasn't repeated for this long has stopped. */
export const CALL_RING_GONE_MS = 12_000;
/** How long the caller keeps waiting after the callee says `answering`. */
export const CALL_ANSWERING_MS = 60_000;

const KINDS = ['ring', 'cancel', 'answering', 'decline', 'busy'] as const;
const PERSON_PREFIX = 'person/';

export interface CallRingMessage {
  t: (typeof KINDS)[number];
  room: string;
}

export function cleanCallRing(value: unknown): CallRingMessage | null {
  const raw = value as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  const kind = KINDS.find((k) => k === raw.t);
  if (!kind || !isCallRoom(raw.room) || !raw.room.startsWith(PERSON_PREFIX)) return null;
  return { t: kind, room: raw.room };
}

/** Whether `room` is a call with one person rather than a Circle's room. */
export function isPersonRoom(room: string): boolean {
  return room.startsWith(PERSON_PREFIX);
}

/** A fresh room for a call with one person. */
export function newPersonRoom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return PERSON_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type DialStatus = 'calling' | 'answered' | 'no-answer' | 'busy' | 'declined';

/** The caller's side of one ring. */
export class Dialer {
  private current: DialStatus = 'calling';
  private every: ReturnType<typeof setInterval> | null = null;
  private giveUp: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopped = false;
  private answering = false;
  private readonly listeners = new Listeners();

  constructor(private readonly opts: { room: string; to: string; send: (message: CallRingMessage) => void }) {}

  get status(): DialStatus {
    return this.current;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.ring();
    this.every = setInterval(() => this.ring(), CALL_RING_EVERY_MS);
    this.giveUp = setTimeout(() => this.finish('no-answer'), CALL_RING_MS);
  }

  receive(from: string, message: CallRingMessage): void {
    if (this.stopped || this.current !== 'calling' || from !== this.opts.to || message.room !== this.opts.room) return;
    if (message.t === 'answering') {
      if (this.answering) return;
      this.answering = true;
      this.clearTimers();
      this.giveUp = setTimeout(() => this.finish('no-answer'), CALL_ANSWERING_MS);
    } else if (message.t === 'decline') this.finish('declined');
    else if (message.t === 'busy') this.finish('busy');
  }

  /** The person has shown up in the room. */
  arrived(): void {
    if (this.stopped || this.current !== 'calling') return;
    this.clearTimers();
    this.current = 'answered';
    this.listeners.emit();
  }

  /** Stop for good: cancels a ring still calling, and ignores anything heard after. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    if (this.current === 'calling' && this.started) this.opts.send({ t: 'cancel', room: this.opts.room });
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private ring(): void {
    this.opts.send({ t: 'ring', room: this.opts.room });
  }

  private finish(status: DialStatus): void {
    this.clearTimers();
    this.current = status;
    this.opts.send({ t: 'cancel', room: this.opts.room });
    this.listeners.emit();
  }

  private clearTimers(): void {
    if (this.every) clearInterval(this.every);
    if (this.giveUp) clearTimeout(this.giveUp);
    this.every = null;
    this.giveUp = null;
  }
}

export interface Ring {
  circleKey: string;
  from: string;
  room: string;
  since: number;
}

/**
 * Calls ringing on this device, one per room. A ring this user answered leaves `rings` for
 * `answering` while they choose devices, and stays until the caller cancels, another device
 * answers, it is dismissed or `CALL_ANSWERING_MS` passes, as long as the caller waits.
 */
export class RingInbox {
  private readonly byRoom = new Map<string, Ring & { seen: number; answeredAt: number | null }>();
  /** Rooms whose ring was cancelled, answered elsewhere or dismissed, by when it started. */
  private readonly dropped = new Map<string, number>();
  private readonly listeners = new Listeners();

  /** Rings still waiting for an answer. */
  get rings(): Ring[] {
    return this.list(false);
  }

  /** Rings this user answered, while they choose devices. */
  get answering(): Ring[] {
    return this.list(true);
  }

  /** This user is coming: the ring leaves `rings` but is kept until it ends. */
  answer(room: string, now: number): void {
    const known = this.byRoom.get(room);
    if (!known || known.answeredAt !== null) return;
    known.answeredAt = now;
    this.listeners.emit();
  }

  receive(circleKey: string, from: string, message: CallRingMessage, now: number): void {
    const known = this.byRoom.get(message.room);
    if (message.t === 'ring') {
      if (known) {
        if (known.circleKey === circleKey && known.from === from) known.seen = now;
        return;
      }
      const droppedSince = this.dropped.get(message.room);
      if (droppedSince !== undefined && now - droppedSince < CALL_RING_MS) return;
      this.dropped.delete(message.room);
      this.byRoom.set(message.room, { circleKey, from, room: message.room, since: now, seen: now, answeredAt: null });
      this.listeners.emit();
    } else if (message.t === 'cancel' && known && known.circleKey === circleKey && known.from === from) {
      this.remove(message.room);
    }
  }

  /** The caller is in the room, so another of the callee's devices answered. */
  present(circleKey: string, from: string, room: string): void {
    const known = this.byRoom.get(room);
    if (known && known.circleKey === circleKey && known.from === from) this.remove(room);
  }

  expire(now: number): void {
    let changed = false;
    for (const [room, ring] of this.byRoom) {
      // The caller stops repeating once told this user is coming, and waits longer.
      const over =
        ring.answeredAt === null
          ? now - ring.seen >= CALL_RING_GONE_MS || now - ring.since >= CALL_RING_MS
          : now - ring.answeredAt >= CALL_ANSWERING_MS;
      if (over) {
        this.byRoom.delete(room);
        changed = true;
      }
    }
    for (const [room, since] of this.dropped) if (now - since >= CALL_RING_MS) this.dropped.delete(room);
    if (changed) this.listeners.emit();
  }

  dismiss(room: string): void {
    this.remove(room);
  }

  /** Drop the rings of Circles not in `keys`. */
  keepCircles(keys: Set<string>): void {
    for (const ring of [...this.byRoom.values()]) if (!keys.has(ring.circleKey)) this.remove(ring.room);
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private list(answered: boolean): Ring[] {
    return [...this.byRoom.values()]
      .filter((ring) => (ring.answeredAt !== null) === answered)
      .map(({ circleKey, from, room, since }) => ({ circleKey, from, room, since }));
  }

  /** Drop a ring and ignore repeats for its room until it would have stopped ringing. */
  private remove(room: string): void {
    const known = this.byRoom.get(room);
    if (!known) return;
    this.byRoom.delete(room);
    this.dropped.set(room, known.since);
    this.listeners.emit();
  }
}
