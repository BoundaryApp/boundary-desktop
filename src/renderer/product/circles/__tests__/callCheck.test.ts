import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addSwarmCandidates,
  readConnectStats,
  readIceStats,
  watchIce,
  readLoadStats,
  readMediaStats,
  selectedPairId,
  stripCandidates,
  tunnelCandidate,
  tunnelFields,
} from '../callCheck';

const SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=candidate:1 1 udp 2122260223 4f1c.local 51234 typ host generation 0',
  'a=candidate:2 1 tcp 1518280447 4f1c.local 9 typ host tcptype active',
  'a=candidate:3 1 udp 2122194687 192.168.1.20 51236 typ host generation 0',
  'a=end-of-candidates',
  '',
].join('\r\n');

describe('call check', () => {
  it('adds a public candidate on the same port after each UDP host candidate', () => {
    const lines = addSwarmCandidates(SDP, '203.0.113.9').split('\r\n');
    expect(lines.filter((line) => line.includes('typ srflx'))).toEqual([
      'a=candidate:swarm1 1 udp 1686052607 203.0.113.9 51234 typ srflx raddr 0.0.0.0 rport 51234',
      'a=candidate:swarm2 1 udp 1686052607 203.0.113.9 51236 typ srflx raddr 0.0.0.0 rport 51236',
    ]);
    expect(lines.indexOf('a=candidate:swarm1 1 udp 1686052607 203.0.113.9 51234 typ srflx raddr 0.0.0.0 rport 51234')).toBe(3);
    expect(lines.at(-2)).toBe('a=end-of-candidates');
  });

  it('reads the selected pair and the audio delay', () => {
    expect(
      readConnectStats([
        { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
        { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.04 },
        { id: 'L', type: 'local-candidate', candidateType: 'srflx' },
        { id: 'R', type: 'remote-candidate', candidateType: 'host' },
        { id: 'A', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 3, jitterBufferEmittedCount: 100 },
      ])
    ).toEqual({ localType: 'srflx', remoteType: 'host', rttMs: 40, audioDelayMs: 50 });
  });

  it('falls back to the nominated pair, and leaves out what it can’t read', () => {
    expect(
      readConnectStats([
        { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
        { id: 'L', type: 'local-candidate', candidateType: 'host' },
      ])
    ).toEqual({ localType: 'host' });
    expect(readConnectStats([])).toEqual({});
  });

  it('strips every candidate for tunnel mode and keeps the rest of the description', () => {
    expect(stripCandidates(SDP).split('\r\n')).toEqual(['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', '']);
  });

  it('gives the tunnel endpoint as a low-priority loopback candidate', () => {
    expect(tunnelCandidate(50123, '0')).toEqual({
      candidate: 'candidate:tunnel 1 udp 1000 127.0.0.1 50123 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
  });

  it('says whether the selected pair runs through the tunnel endpoint', () => {
    const report = (address: string, port: number) => [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'L', type: 'local-candidate', candidateType: 'prflx' },
      { id: 'R', type: 'remote-candidate', candidateType: 'host', address, port },
    ];
    expect(readConnectStats(report('127.0.0.1', 50123), 50123).path).toBe('tunnel');
    expect(readConnectStats(report('127.0.0.1', 50999), 50123).path).toBe('direct');
    expect(readConnectStats(report('192.168.1.20', 50123), 50123).path).toBe('direct');
    expect(readConnectStats(report('127.0.0.1', 50123))).not.toHaveProperty('path');
  });

  it('turns tunnel counts into result fields', () => {
    expect(
      tunnelFields({ mtu: 1200, packetsOut: 400, packetsIn: 380, split: 2, dropped: 1, bytesOut: 300_000, bytesIn: 250_000 })
    ).toEqual({
      tunnelMtu: 1200,
      tunnelPackets: 780,
      tunnelSplit: 2,
      tunnelDropped: 1,
      tunnelBytes: 550_000,
    });
  });

  it('counts candidates by type, pairs by outcome, and the connectivity checks', () => {
    expect(
      readIceStats([
        { id: 'L1', type: 'local-candidate', candidateType: 'host' },
        { id: 'L2', type: 'local-candidate', candidateType: 'host' },
        { id: 'L3', type: 'local-candidate', candidateType: 'srflx' },
        { id: 'R1', type: 'remote-candidate', candidateType: 'srflx' },
        { id: 'R2', type: 'remote-candidate', candidateType: 'prflx' },
        { id: 'P1', type: 'candidate-pair', state: 'failed', requestsSent: 9, responsesReceived: 0, requestsReceived: 0 },
        { id: 'P2', type: 'candidate-pair', state: 'in-progress', requestsSent: 4, responsesReceived: 0, requestsReceived: 3 },
      ])
    ).toEqual({
      localHost: 2,
      localSrflx: 1,
      localRelay: 0,
      remoteHost: 0,
      remoteSrflx: 1,
      remotePrflx: 1,
      pairs: 2,
      pairsSucceeded: 0,
      pairsFailed: 1,
      checksSent: 13,
      checksAnswered: 0,
      checksReceived: 3,
    });
  });

  it('reads loss, jitter, bitrates and video trouble over a window', () => {
    const before = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P', bytesSent: 0, bytesReceived: 0 },
      { id: 'A', type: 'inbound-rtp', kind: 'audio', packetsReceived: 100, packetsLost: 0, totalSamplesReceived: 48_000, concealedSamples: 0 },
      { id: 'V', type: 'inbound-rtp', kind: 'video', packetsReceived: 300, packetsLost: 0, framesDropped: 1, freezeCount: 0, totalFreezesDuration: 0, pliCount: 0, nackCount: 2 },
    ];
    const after = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P', bytesSent: 625_000, bytesReceived: 500_000 },
      { id: 'P', type: 'candidate-pair', availableOutgoingBitrate: 2_500_000 },
      { id: 'A', type: 'inbound-rtp', kind: 'audio', packetsReceived: 345, packetsLost: 5, jitter: 0.012, totalSamplesReceived: 288_000, concealedSamples: 2_400 },
      { id: 'V', type: 'inbound-rtp', kind: 'video', packetsReceived: 1_250, packetsLost: 0, framesDropped: 4, freezeCount: 1, totalFreezesDuration: 0.35, pliCount: 2, nackCount: 10 },
    ];
    const media = readMediaStats(before, after, 5);
    expect(media).toEqual({
      lossInPct: expect.closeTo((5 / 1200) * 100, 6),
      jitterMs: 12,
      kbpsOut: 1000,
      kbpsIn: 800,
      availableKbps: 2500,
      framesDropped: 3,
      freezes: 1,
      freezeMs: 350,
      plis: 2,
      nacks: 8,
      concealedPct: 1,
    });
    expect(readMediaStats([], [], 5)).toEqual({ kbpsOut: 0, kbpsIn: 0, nacks: 0 });
  });

  it('names the selected pair, falling back to the nominated one', () => {
    expect(selectedPairId([{ id: 'T', type: 'transport', selectedCandidatePairId: 'P2' }])).toBe('P2');
    expect(selectedPairId([{ id: 'P1', type: 'candidate-pair', nominated: true, state: 'succeeded' }])).toBe('P1');
    expect(selectedPairId([])).toBeNull();
  });

  it('reads frames a second each way and why sending was held back', () => {
    const before = [
      { id: 'O', type: 'outbound-rtp', kind: 'video', framesEncoded: 100 },
      { id: 'I', type: 'inbound-rtp', kind: 'video', framesDecoded: 90 },
    ];
    const after = [
      { id: 'O', type: 'outbound-rtp', kind: 'video', framesEncoded: 250, qualityLimitationReason: 'cpu' },
      { id: 'I', type: 'inbound-rtp', kind: 'video', framesDecoded: 190 },
    ];
    expect(readLoadStats(before, after, 5)).toEqual({ sentFps: 30, receivedFps: 20, limitedBy: 'cpu' });
    expect(readLoadStats(before, [{ ...after[0], qualityLimitationReason: 'other-thing' }], 5).limitedBy).toBe('other');
  });

  describe('watching ICE while it connects', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const pair = (requestsSent: number) => ({ id: 'p', type: 'candidate-pair', state: 'in-progress', requestsSent });
    const remote = { id: 'r', type: 'remote-candidate', candidateType: 'srflx' };

    it('keeps the last reading with pairs, since failed pairs leave the stats when ICE gives up', async () => {
      vi.useFakeTimers();
      const readings = [[], [remote, pair(4)], [remote, pair(12)], []];
      let call = 0;
      const pc = { getStats: () => Promise.resolve(readings[Math.min(call++, readings.length - 1)] as unknown as RTCStatsReport) };
      const ice = watchIce(pc, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(ice.last()).toMatchObject({ pairs: 0, remoteSrflx: 0 });
      await vi.advanceTimersByTimeAsync(2000);
      expect(ice.last()).toMatchObject({ pairs: 1, remoteSrflx: 1, checksSent: 12 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ice.last()).toMatchObject({ pairs: 1, checksSent: 12 });
      ice.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(call).toBe(4);
    });

    it('ignores a reading that fails or arrives after it stopped', async () => {
      vi.useFakeTimers();
      let resolve: (report: RTCStatsReport) => void = () => undefined;
      const pc = {
        getStats: vi
          .fn()
          .mockRejectedValueOnce(new Error('closed'))
          .mockImplementationOnce(() => new Promise<RTCStatsReport>((done) => (resolve = done))),
      };
      const ice = watchIce(pc, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      ice.stop();
      resolve([remote, pair(3)] as unknown as RTCStatsReport);
      await vi.advanceTimersByTimeAsync(0);
      expect(ice.last()).toEqual({});
    });
  });
});
