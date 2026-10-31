/**
 * Peer signals: short messages between the members of a Circle that nothing keeps, for things
 * like typing indicators and read marks. This module holds the rules both processes share; the
 * Protomux channel is in signalChannel.ts.
 */

/** The longest payload, as JSON text. */
export const MAX_SIGNAL_PAYLOAD_BYTES = 4096;
/** A frame is a payload plus its Circle key, topic and JSON punctuation. */
export const MAX_SIGNAL_FRAME_BYTES = MAX_SIGNAL_PAYLOAD_BYTES + 256;

/**
 * Per peer. A sender stays under the send limit, and a receiver allows twice that so timing
 * jitter doesn't drop an honest peer's messages.
 */
export const SIGNAL_SEND_RATE = { perSecond: 30, burst: 60 };
export const SIGNAL_RECEIVE_RATE = { perSecond: 60, burst: 120 };

const TOPIC = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CIRCLE_KEY = /^[0-9a-f]{64}$/;

export interface CircleSignalFrame {
  circle: string;
  topic: string;
  payload: unknown;
}

/** A signal that passed the receiver's checks. `from` comes from the connection, not the sender. */
export interface CircleSignal extends CircleSignalFrame {
  from: string;
}

export const isSignalTopic = (topic: unknown): topic is string => typeof topic === 'string' && TOPIC.test(topic);

/** The frame to send. Throws on a bad topic or a payload that is too long or isn't JSON. */
export function encodeSignal(frame: CircleSignalFrame): Buffer {
  if (!isSignalTopic(frame.topic)) throw new Error('That isn’t a signal topic.');
  const payload = JSON.stringify(frame.payload);
  if (payload === undefined) throw new Error('A signal payload must be JSON.');
  if (Buffer.byteLength(payload) > MAX_SIGNAL_PAYLOAD_BYTES) throw new Error('That signal payload is too long.');
  return Buffer.from(JSON.stringify({ circle: frame.circle, topic: frame.topic, payload: frame.payload }));
}

/** The frame in `raw`, or null when it is too long or malformed. The other side is not trusted. */
export function decodeSignal(raw: Buffer): CircleSignalFrame | null {
  if (raw.length > MAX_SIGNAL_FRAME_BYTES) return null;
  let frame: Partial<CircleSignalFrame> | null;
  try {
    frame = JSON.parse(raw.toString('utf8')) as Partial<CircleSignalFrame> | null;
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;
  const { circle, topic, payload } = frame;
  if (typeof circle !== 'string' || !CIRCLE_KEY.test(circle) || !isSignalTopic(topic) || payload === undefined) return null;
  return { circle, topic, payload };
}

/** A token bucket. `now` is passed in so callers and tests share one clock. */
export class SignalRate {
  private tokens: number;
  private refilledAt: number;

  constructor(
    private readonly limit: { perSecond: number; burst: number },
    now: number
  ) {
    this.tokens = limit.burst;
    this.refilledAt = now;
  }

  /** Spend a token; false when none are left. */
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.refilledAt) / 1000;
    this.tokens = Math.min(this.limit.burst, this.tokens + elapsed * this.limit.perSecond);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts for the health record: per topic, and drops by reason, never a payload or peer topic. */
export class SignalStats {
  private readonly sent = new Map<string, { messages: number; bytes: number }>();
  private readonly received = new Map<string, { messages: number; bytes: number }>();
  private readonly dropped = new Map<string, number>();

  private static add(counts: Map<string, { messages: number; bytes: number }>, topic: string, bytes: number): void {
    const entry = counts.get(topic) ?? { messages: 0, bytes: 0 };
    entry.messages += 1;
    entry.bytes += bytes;
    counts.set(topic, entry);
  }

  onSent(topic: string, bytes: number): void {
    SignalStats.add(this.sent, topic, bytes);
  }

  /** Only called for topics this device listens to, so a peer can't grow the map. */
  onReceived(topic: string, bytes: number): void {
    SignalStats.add(this.received, topic, bytes);
  }

  onDropped(reason: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
  }

  summary(): Record<string, unknown> {
    return {
      sent: Object.fromEntries(this.sent),
      received: Object.fromEntries(this.received),
      dropped: Object.fromEntries(this.dropped),
    };
  }
}
