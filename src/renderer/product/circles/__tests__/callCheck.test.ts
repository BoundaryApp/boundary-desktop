import { describe, expect, it } from 'vitest';
import { addSwarmCandidates, readConnectStats, readLoadStats } from '../callCheck';

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
});
