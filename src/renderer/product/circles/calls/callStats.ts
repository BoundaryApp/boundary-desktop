/**
 * Readers for WebRTC stats reports, shared by live calls (the peer and the call log) and the call
 * transport check. Pure functions of a report, so editing the check can't break a call.
 */
import type { CallCheckMedia, CallCheckResult } from '../../../../shared/callCheck';

/**
 * This Mac's tunnel endpoint as a remote candidate. Its priority is below any real candidate's,
 * so ICE uses it only when no direct pair works.
 */
export function tunnelCandidate(port: number, sdpMid: string | null): RTCIceCandidateInit {
  return { candidate: `candidate:tunnel 1 udp 1000 127.0.0.1 ${port} typ host`, sdpMid, sdpMLineIndex: 0 };
}

export type StatsList = Array<Record<string, unknown> & { id: string; type: string }>;

export function statsList(report: RTCStatsReport | StatsList): StatsList {
  return Array.isArray(report) ? report : ([...report.values()] as StatsList);
}

type CandidateType = NonNullable<CallCheckResult['localType']>;

/**
 * The selected pair's candidate types and round trip, and the audio delay, from one stats report.
 * With `tunnelPort`, also whether the pair runs through the tunnel endpoint.
 */
export function readConnectStats(report: RTCStatsReport | StatsList, tunnelPort?: number): Partial<CallCheckResult> {
  const stats = statsList(report);
  const byId = new Map(stats.map((entry) => [entry.id, entry]));
  const transport = stats.find((entry) => entry.type === 'transport');
  const pair =
    (transport?.selectedCandidatePairId ? byId.get(String(transport.selectedCandidatePairId)) : undefined) ??
    stats.find((entry) => entry.type === 'candidate-pair' && entry.nominated === true && entry.state === 'succeeded');
  const out: Partial<CallCheckResult> = {};
  if (pair) {
    const local = byId.get(String(pair.localCandidateId));
    const remote = byId.get(String(pair.remoteCandidateId));
    if (local?.candidateType) out.localType = local.candidateType as CandidateType;
    if (remote?.candidateType) out.remoteType = remote.candidateType as CandidateType;
    if (typeof pair.currentRoundTripTime === 'number') out.rttMs = pair.currentRoundTripTime * 1000;
    if (tunnelPort !== undefined && remote) {
      out.path = remote.address === '127.0.0.1' && remote.port === tunnelPort ? 'tunnel' : 'direct';
    }
  }
  const audio = stats.find((entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio');
  const emitted = Number(audio?.jitterBufferEmittedCount ?? 0);
  if (audio && emitted > 0 && out.rttMs !== undefined) {
    out.audioDelayMs = out.rttMs / 2 + (Number(audio.jitterBufferDelay) / emitted) * 1000;
  }
  return out;
}

/** The selected candidate pair's id, to notice the connection switching paths. */
export function selectedPairId(report: RTCStatsReport | StatsList): string | null {
  const stats = statsList(report);
  const transport = stats.find((entry) => entry.type === 'transport');
  if (transport?.selectedCandidatePairId) return String(transport.selectedCandidatePairId);
  const nominated = stats.find((entry) => entry.type === 'candidate-pair' && entry.nominated === true && entry.state === 'succeeded');
  return nominated ? nominated.id : null;
}

/** Loss, jitter, bitrates and video trouble over a window between two stats reports. */
export function readMediaStats(
  before: RTCStatsReport | StatsList,
  after: RTCStatsReport | StatsList,
  seconds: number
): CallCheckMedia {
  const a = statsList(before);
  const b = statsList(after);
  const total = (report: StatsList, type: string, field: string, kind?: string) =>
    report
      .filter((entry) => entry.type === type && (kind === undefined || entry.kind === kind))
      .reduce((sum, entry) => sum + Number(entry[field] ?? 0), 0);
  const delta = (type: string, field: string, kind?: string) => total(b, type, field, kind) - total(a, type, field, kind);
  const out: CallCheckMedia = {};
  const received = delta('inbound-rtp', 'packetsReceived');
  const lost = delta('inbound-rtp', 'packetsLost');
  if (received + lost > 0) out.lossInPct = (Math.max(0, lost) / (received + lost)) * 100;
  const audio = b.find((entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio');
  if (typeof audio?.jitter === 'number') out.jitterMs = audio.jitter * 1000;
  if (seconds > 0) {
    out.kbpsOut = (delta('transport', 'bytesSent') * 8) / 1000 / seconds;
    out.kbpsIn = (delta('transport', 'bytesReceived') * 8) / 1000 / seconds;
  }
  const pairId = selectedPairId(b);
  const pair = pairId ? b.find((entry) => entry.id === pairId) : undefined;
  if (typeof pair?.availableOutgoingBitrate === 'number') out.availableKbps = pair.availableOutgoingBitrate / 1000;
  if (b.some((entry) => entry.type === 'inbound-rtp' && entry.kind === 'video')) {
    out.framesDropped = delta('inbound-rtp', 'framesDropped', 'video');
    out.freezes = delta('inbound-rtp', 'freezeCount', 'video');
    out.freezeMs = delta('inbound-rtp', 'totalFreezesDuration', 'video') * 1000;
    out.plis = delta('inbound-rtp', 'pliCount', 'video');
  }
  out.nacks = delta('inbound-rtp', 'nackCount');
  const samples = delta('inbound-rtp', 'totalSamplesReceived', 'audio');
  if (samples > 0) out.concealedPct = (delta('inbound-rtp', 'concealedSamples', 'audio') / samples) * 100;
  return out;
}
