/**
 * The call transport check (Circle calls spec phase 1): real WebRTC connections between members,
 * set up over peer signals, measured and logged as metadata. It runs only when the app starts with
 * `BOUNDARY_CALLS_CHECK=1`, on every Mac taking part.
 */

/**
 * How a connection learns addresses: none but its own, a public STUN server, or the DHT's view.
 * `tunnel` uses only this Mac's call tunnel, which carries packets over the Circles connection;
 * `stun+tunnel` offers both, so ICE picks a direct path when one works.
 */
export type CallCheckMode = 'host' | 'stun' | 'swarm' | 'tunnel' | 'stun+tunnel';

export const CALL_CHECK_MODES: CallCheckMode[] = ['host', 'stun', 'swarm', 'tunnel', 'stun+tunnel'];

/** Modes that open a call tunnel. */
export const usesTunnel = (mode: CallCheckMode): boolean => mode === 'tunnel' || mode === 'stun+tunnel';

/** Metadata only: counts and the connection's MTU. */
export interface CallTunnelStats {
  mtu: number;
  /** Packets WebRTC sent into the tunnel, and packets delivered to it from the other side. */
  packetsOut: number;
  packetsIn: number;
  /** Outgoing packets that went as two halves. */
  split: number;
  /** Arrived before WebRTC had sent anything, halves that never met, too big even split, or refused by libudx. */
  dropped: number;
  /** UDP payload bytes each way. */
  bytesOut: number;
  bytesIn: number;
}


/** The STUN server the `stun` mode uses. It learns each Mac's address and when it checks. */
export const CALL_CHECK_STUN = 'stun:stun.cloudflare.com:3478';

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;
type CandidateType = (typeof CANDIDATE_TYPES)[number];
const LIMITS = ['none', 'cpu', 'bandwidth', 'other'] as const;
type Limit = (typeof LIMITS)[number];
const STAGES = ['offer', 'answer', 'tunnel', 'ice', 'timeout', 'error'] as const;
type Stage = (typeof STAGES)[number];

const KINDS = ['connect', 'load', 'long'] as const;
const ROLES = ['caller', 'answerer'] as const;
const PATHS = ['direct', 'tunnel'] as const;
/** Kinds of address, as `addressClass` in the Circles network names them; never the address itself. */
const ADDRESS_CLASSES = ['none', 'loopback', 'lan', 'cgnat', 'link-local', 'public', 'ipv6', 'unknown'] as const;
export type CallAddressClass = (typeof ADDRESS_CLASSES)[number];

/** Media measured over a window: what a call would feel like. */
export interface CallCheckMedia {
  /** Inbound audio and video packets lost, as a percentage of those expected. */
  lossInPct?: number;
  /** Inbound audio jitter. */
  jitterMs?: number;
  /** Bitrate sent and received, all streams on this connection. */
  kbpsOut?: number;
  kbpsIn?: number;
  /** WebRTC's estimate of the bandwidth it can send with. */
  availableKbps?: number;
  /** Inbound video frames dropped, freezes and their total length, and repair requests sent. */
  framesDropped?: number;
  freezes?: number;
  freezeMs?: number;
  nacks?: number;
  plis?: number;
  /** Inbound audio samples made up to hide loss, as a percentage. */
  concealedPct?: number;
}

/** One connection's outcome. Numbers and fixed words only: no addresses, names or keys. */
export interface CallCheckResult extends CallCheckMedia {
  /** 8 hex characters shared by both ends of one run. */
  run: string;
  /** `long` is one video connection held for minutes, sampled every few seconds. */
  kind: 'connect' | 'load' | 'long';
  mode: CallCheckMode;
  role: 'caller' | 'answerer';
  connected: boolean;
  failedAt?: Stage;
  /** Time spent gathering this Mac's own candidates. */
  gatherMs?: number;
  msToConnect?: number;
  /** This Mac's candidates and the other Mac's, by type. A zero `localSrflx` in a STUN mode means STUN never answered. */
  localHost?: number;
  localSrflx?: number;
  localRelay?: number;
  remoteHost?: number;
  remoteSrflx?: number;
  remotePrflx?: number;
  /** Candidate pairs ICE formed, how many succeeded and failed, and its connectivity checks: sent, answered, received. */
  pairs?: number;
  pairsSucceeded?: number;
  pairsFailed?: number;
  checksSent?: number;
  checksAnswered?: number;
  checksReceived?: number;
  localType?: CandidateType;
  remoteType?: CandidateType;
  rttMs?: number;
  /** Network delay one way plus the receiver's jitter buffer, for audio. */
  audioDelayMs?: number;
  /** The session description's JSON size, what went over the wire compressed, and in how many parts. */
  descriptionBytes?: number;
  descriptionSent?: number;
  descriptionParts?: number;
  /** Load runs: video streams each way, and frames a second sent and received per stream. */
  streams?: number;
  sentFps?: number;
  receivedFps?: number;
  limitedBy?: Limit;
  /** Tunnel modes: whether the call ended on the tunnel or a direct path, and the tunnel's counts. */
  path?: 'direct' | 'tunnel';
  tunnelMtu?: number;
  tunnelPackets?: number;
  tunnelSplit?: number;
  tunnelDropped?: number;
  tunnelBytes?: number;
  /** How often the selected pair changed while measuring, and how many samples were taken. */
  pathSwitches?: number;
  samples?: number;
  /** Added by main: the app's CPU use when the result arrived, in all and by process kind. */
  cpuPercent?: number;
  cpuBrowser?: number;
  cpuRenderer?: number;
  cpuGpu?: number;
  cpuUtility?: number;
  /** Added by main: the DHT's view of this Mac's network, and the Circles connection to that member. */
  natFirewalled?: boolean;
  natRandomized?: boolean;
  peerConnected?: boolean;
  peerAddr?: CallAddressClass;
  peerRttMs?: number;
  peerRetransmits?: number;
  peerAgeS?: number;
  peerMtu?: number;
}

/** One sample of a connection while it's measured, every few seconds. Logged as `call.sample`. */
export interface CallCheckSample extends CallCheckMedia {
  run: string;
  stream: number;
  kind: CallCheckResult['kind'];
  mode: CallCheckMode;
  role: CallCheckResult['role'];
  /** Seconds since the connection connected. */
  t: number;
  path?: CallCheckResult['path'];
  /** The selected pair is not the one in the previous sample. */
  switched?: boolean;
  rttMs?: number;
  sentFps?: number;
  receivedFps?: number;
  limitedBy?: Limit;
}

const num = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 10) / 10 : undefined;

const word = <T extends string>(value: unknown, words: readonly T[]): T | undefined =>
  words.includes(value as T) ? (value as T) : undefined;

const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

const COUNT = 1_000_000_000;

/** Media fields, shared by results and samples. */
function mediaFields(raw: Record<string, unknown>): CallCheckMedia {
  return {
    lossInPct: num(raw.lossInPct, 100),
    jitterMs: num(raw.jitterMs, 60_000),
    kbpsOut: num(raw.kbpsOut, 10_000_000),
    kbpsIn: num(raw.kbpsIn, 10_000_000),
    availableKbps: num(raw.availableKbps, 10_000_000),
    framesDropped: num(raw.framesDropped, COUNT),
    freezes: num(raw.freezes, COUNT),
    freezeMs: num(raw.freezeMs, COUNT),
    nacks: num(raw.nacks, COUNT),
    plis: num(raw.plis, COUNT),
    concealedPct: num(raw.concealedPct, 100),
  };
}

function keepDefined<T extends object>(target: T, fields: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
  return target;
}

const RUN = /^[0-9a-f]{8}$/;

/** The fields every result and sample must have, or null when one is missing or wrong. */
function identify(raw: Record<string, unknown>): Pick<CallCheckResult, 'run' | 'kind' | 'mode' | 'role'> | null {
  const mode = word(raw.mode, CALL_CHECK_MODES);
  const kind = word(raw.kind, KINDS);
  const role = word(raw.role, ROLES);
  if (typeof raw.run !== 'string' || !RUN.test(raw.run) || !mode || !kind || !role) return null;
  return { run: raw.run, kind, mode, role };
}

/** Keep only a result's known fields with sane values, so nothing else reaches the log. */
export function cleanCallCheckResult(input: unknown): CallCheckResult | null {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = identify(raw);
  if (!id) return null;
  const result: CallCheckResult = { ...id, connected: raw.connected === true };
  return keepDefined(result, {
    failedAt: word(raw.failedAt, STAGES),
    gatherMs: num(raw.gatherMs, 600_000),
    msToConnect: num(raw.msToConnect, 600_000),
    localType: word(raw.localType, CANDIDATE_TYPES),
    remoteType: word(raw.remoteType, CANDIDATE_TYPES),
    localHost: num(raw.localHost, 1000),
    localSrflx: num(raw.localSrflx, 1000),
    localRelay: num(raw.localRelay, 1000),
    remoteHost: num(raw.remoteHost, 1000),
    remoteSrflx: num(raw.remoteSrflx, 1000),
    remotePrflx: num(raw.remotePrflx, 1000),
    pairs: num(raw.pairs, 10_000),
    pairsSucceeded: num(raw.pairsSucceeded, 10_000),
    pairsFailed: num(raw.pairsFailed, 10_000),
    checksSent: num(raw.checksSent, COUNT),
    checksAnswered: num(raw.checksAnswered, COUNT),
    checksReceived: num(raw.checksReceived, COUNT),
    rttMs: num(raw.rttMs, 60_000),
    audioDelayMs: num(raw.audioDelayMs, 60_000),
    descriptionBytes: num(raw.descriptionBytes, 1_000_000),
    descriptionSent: num(raw.descriptionSent, 1_000_000),
    descriptionParts: num(raw.descriptionParts, 100),
    streams: num(raw.streams, 16),
    sentFps: num(raw.sentFps, 240),
    receivedFps: num(raw.receivedFps, 240),
    limitedBy: word(raw.limitedBy, LIMITS),
    path: word(raw.path, PATHS),
    tunnelMtu: num(raw.tunnelMtu, 65_535),
    tunnelPackets: num(raw.tunnelPackets, COUNT),
    tunnelSplit: num(raw.tunnelSplit, COUNT),
    tunnelDropped: num(raw.tunnelDropped, COUNT),
    tunnelBytes: num(raw.tunnelBytes, 1e12),
    pathSwitches: num(raw.pathSwitches, 10_000),
    samples: num(raw.samples, 10_000),
    ...mediaFields(raw),
    // Main adds these when it logs a result; keep them when an exported row is cleaned again.
    cpuPercent: num(raw.cpuPercent, 100_000),
    cpuBrowser: num(raw.cpuBrowser, 100_000),
    cpuRenderer: num(raw.cpuRenderer, 100_000),
    cpuGpu: num(raw.cpuGpu, 100_000),
    cpuUtility: num(raw.cpuUtility, 100_000),
    natFirewalled: bool(raw.natFirewalled),
    natRandomized: bool(raw.natRandomized),
    peerConnected: bool(raw.peerConnected),
    peerAddr: word(raw.peerAddr, ADDRESS_CLASSES),
    peerRttMs: num(raw.peerRttMs, 600_000),
    peerRetransmits: num(raw.peerRetransmits, COUNT),
    peerAgeS: num(raw.peerAgeS, 1e9),
    peerMtu: num(raw.peerMtu, 65_535),
  });
}

/** The same for one sample. */
export function cleanCallCheckSample(input: unknown): CallCheckSample | null {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = identify(raw);
  const stream = num(raw.stream, 16);
  const t = num(raw.t, 86_400);
  if (!id || stream === undefined || t === undefined) return null;
  return keepDefined<CallCheckSample>(
    { ...id, stream, t },
    {
      path: word(raw.path, PATHS),
      switched: bool(raw.switched),
      rttMs: num(raw.rttMs, 60_000),
      sentFps: num(raw.sentFps, 240),
      receivedFps: num(raw.receivedFps, 240),
      limitedBy: word(raw.limitedBy, LIMITS),
      ...mediaFields(raw),
    }
  );
}
