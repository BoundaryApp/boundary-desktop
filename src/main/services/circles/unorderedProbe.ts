/**
 * Measures unordered messages (`@hyperswarm/secret-stream`'s `trySend`) on one connection, for
 * the phase 0 spike. Each side sends numbered messages at a steady rate and reports what arrived
 * from the other, so the debug logs of two Macs show loss, duplicates and reordering on a real
 * path. libudx sends each message as one UDP datagram with no acknowledgement or retransmission.
 */

/** The parts of a Hyperswarm connection the probe uses. */
export interface UnorderedChannel {
  /** Resolves true once this side's handshake is done; messages sent before that are dropped. */
  readonly opened: Promise<boolean>;
  trySend(buffer: Buffer): void;
  on(event: 'message', listener: (message: Buffer) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

export interface ProbeReport {
  sent: number;
  received: number;
  unique: number;
  lost: number;
  duplicates: number;
  /** Messages that arrived after one with a higher number. */
  outOfOrder: number;
}

/** 50 messages a second for 20 seconds, about the rate of avatar steps. */
export const PROBE_COUNT = 1_000;
export const PROBE_INTERVAL_MS = 20;
const PROBE_BYTES = 64;
/** Lets the other side finish its handshake, which can end after ours. */
const PROBE_START_DELAY_MS = 1_000;
/** Time for the last messages to arrive before the report. */
const PROBE_SETTLE_MS = 3_000;
const MAGIC = 0x42435031; // "BCP1"

export function probeMessage(sequence: number): Buffer {
  const message = Buffer.alloc(PROBE_BYTES);
  message.writeUInt32BE(MAGIC, 0);
  message.writeUInt32BE(sequence, 4);
  return message;
}

/** The probe sequence number in a message, or null for anything else. */
export function probeSequence(message: Buffer): number | null {
  if (message.byteLength !== PROBE_BYTES || message.readUInt32BE(0) !== MAGIC) return null;
  return message.readUInt32BE(4);
}

export function summarizeProbe(sequences: readonly number[], sent: number): ProbeReport {
  const seen = new Set<number>();
  let duplicates = 0;
  let outOfOrder = 0;
  let highest = -1;
  for (const sequence of sequences) {
    if (seen.has(sequence)) duplicates++;
    else seen.add(sequence);
    if (sequence < highest) outOfOrder++;
    highest = Math.max(highest, sequence);
  }
  return { sent, received: sequences.length, unique: seen.size, lost: sent - seen.size, duplicates, outOfOrder };
}

/**
 * Sends `PROBE_COUNT` messages once the channel opens, then reports what arrived from the other
 * side, which runs the same probe. A connection that closes first reports nothing.
 */
export function runUnorderedProbe(channel: UnorderedChannel, report: (summary: ProbeReport) => void): void {
  const received: number[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;
  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };

  channel.on('message', (message) => {
    const sequence = probeSequence(message);
    if (sequence !== null) received.push(sequence);
  });
  channel.once('close', () => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });

  const send = (sequence: number) => {
    channel.trySend(probeMessage(sequence));
    if (sequence + 1 < PROBE_COUNT) later(PROBE_INTERVAL_MS, () => send(sequence + 1));
    else later(PROBE_SETTLE_MS, () => report(summarizeProbe(received, PROBE_COUNT)));
  };

  void channel.opened.then((opened) => {
    if (opened && !closed) later(PROBE_START_DELAY_MS, () => send(0));
  });
}
