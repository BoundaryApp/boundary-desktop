import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallLogInput } from '../../../../../shared/calls/callLog';
import { CallLogger, LOG_SAMPLE_MS, type StatsSource } from '../callLogger';

const MAYA = 'ff2e6bbf'.repeat(8);
const SESSION = '0123abcd89abcdef';
const TUNNEL = 50123;

type Stats = Array<Record<string, unknown> & { id: string; type: string }>;

/** A stats report with one selected pair, through the tunnel or direct, and inbound counts. */
function stats({ pair = 'p1', tunnel = false, received = 0, lost = 0, bytes = 0, freezes = 0 } = {}): Stats {
  return [
    { id: 't', type: 'transport', selectedCandidatePairId: pair, bytesSent: bytes, bytesReceived: bytes },
    { id: pair, type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.068 },
    { id: 'l', type: 'local-candidate', candidateType: tunnel ? 'host' : 'srflx' },
    tunnel
      ? { id: 'r', type: 'remote-candidate', candidateType: 'host', address: '127.0.0.1', port: TUNNEL }
      : { id: 'r', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.9', port: 40000 },
    { id: 'in-v', type: 'inbound-rtp', kind: 'video', packetsReceived: received, packetsLost: lost, freezeCount: freezes },
  ];
}

class Source implements StatsSource {
  tunnelPort: number | null = TUNNEL;
  constructor(public next: Stats) {}
  async getStats() {
    return this.next;
  }
}

describe('CallLogger', () => {
  let logged: CallLogInput[];
  let logger: CallLogger;
  beforeEach(() => {
    vi.useFakeTimers();
    logged = [];
    logger = new CallLogger(SESSION, (input) => logged.push(input));
  });
  afterEach(() => {
    logger.dispose();
    vi.useRealTimers();
  });

  it('logs a connect with the path, candidate types, setup time and round trip', async () => {
    const link = new Source(stats({ tunnel: true }));
    await logger.connected({ identity: MAYA, role: 'answer', ms: 812 }, link);
    expect(logged).toEqual([
      { kind: 'connect', s: '0123abcd', peer: 'ff2e6bbf', role: 'answer', ms: 812, path: 'tunnel', localType: 'host', remoteType: 'host', rttMs: 68 },
    ]);
  });

  it('logs an end with length, path switches and loss over the call, from the last sample', async () => {
    const link = new Source(stats({ pair: 'p1', tunnel: true }));
    await logger.connected({ identity: MAYA, role: 'offer', ms: 500 }, link);
    link.next = stats({ pair: 'p2', received: 990, lost: 10, bytes: 1_250_000, freezes: 1 });
    await vi.advanceTimersByTimeAsync(LOG_SAMPLE_MS);
    logger.ended({ identity: MAYA, seconds: 10 }, link);
    expect(logged[1]).toEqual({
      kind: 'end',
      s: '0123abcd',
      peer: 'ff2e6bbf',
      seconds: 10,
      path: 'direct',
      pathSwitches: 1,
      rttMs: 68,
      lossInPct: 1,
      kbpsIn: 2000,
      kbpsOut: 2000,
      freezes: 1,
    });
  });

  it('stops sampling a link once it has ended', async () => {
    const link = new Source(stats());
    const read = vi.spyOn(link, 'getStats');
    await logger.connected({ identity: MAYA, role: 'offer', ms: 500 }, link);
    logger.ended({ identity: MAYA, seconds: 1 }, link);
    read.mockClear();
    await vi.advanceTimersByTimeAsync(LOG_SAMPLE_MS * 3);
    expect(read).not.toHaveBeenCalled();
  });

  it('logs a connect without stats when they can’t be read', async () => {
    const link = new Source(stats());
    vi.spyOn(link, 'getStats').mockRejectedValue(new Error('closed'));
    await logger.connected({ identity: MAYA, role: 'offer', ms: 500 }, link);
    expect(logged).toEqual([{ kind: 'connect', s: '0123abcd', peer: 'ff2e6bbf', role: 'offer', ms: 500 }]);
  });

  it('does not sample a link that ended while its connect was still reading stats', async () => {
    const link = new Source(stats());
    let release: (value: Stats) => void = () => undefined;
    const read = vi.spyOn(link, 'getStats').mockImplementationOnce(() => new Promise<Stats>((resolve) => (release = resolve)));
    const connecting = logger.connected({ identity: MAYA, role: 'offer', ms: 500 }, link);
    logger.ended({ identity: MAYA, seconds: 0 }, link);
    release(stats());
    await connecting;
    read.mockClear();
    await vi.advanceTimersByTimeAsync(LOG_SAMPLE_MS * 2);
    expect(read).not.toHaveBeenCalled();
    expect(logged.map((input) => input.kind)).toEqual(['end', 'connect']);
  });
});
