import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_COUNT,
  PROBE_INTERVAL_MS,
  probeMessage,
  probeSequence,
  runUnorderedProbe,
  summarizeProbe,
  type ProbeReport,
} from '../unorderedProbe';

/** One end of a fake link; `deliver` decides what reaches the other end for each message sent. */
class FakeChannel extends EventEmitter {
  peer: FakeChannel | null = null;
  sent = 0;
  constructor(
    readonly opened: Promise<boolean>,
    private readonly deliver: (sequence: number) => number[] = (sequence) => [sequence]
  ) {
    super();
  }
  trySend(buffer: Buffer): void {
    this.sent++;
    const sequence = probeSequence(buffer)!;
    for (const copy of this.deliver(sequence)) this.peer?.emit('message', probeMessage(copy));
  }
}

function link(a: FakeChannel, b: FakeChannel): void {
  a.peer = b;
  b.peer = a;
}

/** Whole run: start delay, every send, and the settle time. */
const RUN_MS = 1_000 + (PROBE_COUNT - 1) * PROBE_INTERVAL_MS + 3_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('summarizeProbe', () => {
  it('counts loss, duplicates and messages that arrive after a higher one', () => {
    expect(summarizeProbe([0, 2, 1, 2, 4], 5)).toEqual({
      sent: 5,
      received: 5,
      unique: 4,
      lost: 1,
      duplicates: 1,
      outOfOrder: 1,
    });
  });
});

describe('probe messages', () => {
  it('round-trips a sequence number and ignores other messages', () => {
    expect(probeSequence(probeMessage(42))).toBe(42);
    expect(probeSequence(Buffer.alloc(64))).toBeNull();
    expect(probeSequence(Buffer.from('hello'))).toBeNull();
  });
});

describe('runUnorderedProbe', () => {
  it('reports what each side received from the other', async () => {
    // a → b drops every tenth message; b → a swaps each pair and repeats every hundredth.
    const a = new FakeChannel(Promise.resolve(true), (sequence) => (sequence % 10 === 9 ? [] : [sequence]));
    const b = new FakeChannel(Promise.resolve(true), (sequence) => {
      const swapped = sequence % 2 === 0 ? sequence + 1 : sequence - 1;
      return sequence % 100 === 0 ? [swapped, swapped] : [swapped];
    });
    link(a, b);
    const reports: Record<string, ProbeReport> = {};
    runUnorderedProbe(a, (report) => (reports.a = report));
    runUnorderedProbe(b, (report) => (reports.b = report));

    await vi.advanceTimersByTimeAsync(RUN_MS - 1);
    expect(reports).toEqual({});
    await vi.advanceTimersByTimeAsync(1);

    expect(a.sent).toBe(PROBE_COUNT);
    expect(reports.b).toEqual({ sent: 1_000, received: 900, unique: 900, lost: 100, duplicates: 0, outOfOrder: 0 });
    expect(reports.a).toEqual({ sent: 1_000, received: 1_010, unique: 1_000, lost: 0, duplicates: 10, outOfOrder: 500 });
  });

  it('sends nothing on a connection whose handshake failed', async () => {
    const a = new FakeChannel(Promise.resolve(false));
    const report = vi.fn();
    runUnorderedProbe(a, report);

    await vi.advanceTimersByTimeAsync(RUN_MS);

    expect(a.sent).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });

  it('stops sending and reports nothing once the connection closes', async () => {
    const a = new FakeChannel(Promise.resolve(true));
    const report = vi.fn();
    runUnorderedProbe(a, report);

    await vi.advanceTimersByTimeAsync(1_000 + 10 * PROBE_INTERVAL_MS);
    a.emit('close');
    await vi.advanceTimersByTimeAsync(RUN_MS);

    expect(a.sent).toBe(11);
    expect(report).not.toHaveBeenCalled();
  });
});
