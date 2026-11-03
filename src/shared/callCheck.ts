/**
 * The call transport check (Circle calls spec phase 1): real WebRTC connections between members,
 * set up over peer signals, measured and logged as metadata. It runs only when the app starts with
 * `BOUNDARY_CALLS_CHECK=1`, on every Mac taking part.
 */

/** How a connection learns addresses: none but its own, a public STUN server, or the DHT's view. */
export type CallCheckMode = 'host' | 'stun' | 'swarm';

export const CALL_CHECK_MODES: CallCheckMode[] = ['host', 'stun', 'swarm'];

/** The STUN server the `stun` mode uses. It learns each Mac's address and when it checks. */
export const CALL_CHECK_STUN = 'stun:stun.cloudflare.com:3478';

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;
type CandidateType = (typeof CANDIDATE_TYPES)[number];
const LIMITS = ['none', 'cpu', 'bandwidth', 'other'] as const;
type Limit = (typeof LIMITS)[number];
const STAGES = ['offer', 'answer', 'ice', 'timeout', 'error'] as const;
type Stage = (typeof STAGES)[number];

/** One connection's outcome. Numbers and fixed words only: no addresses, names or keys. */
export interface CallCheckResult {
  /** 8 hex characters shared by both ends of one run. */
  run: string;
  kind: 'connect' | 'load';
  mode: CallCheckMode;
  role: 'caller' | 'answerer';
  connected: boolean;
  failedAt?: Stage;
  msToConnect?: number;
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
  /** Added by main: the app's processes' CPU use when the result arrived. */
  cpuPercent?: number;
}

const num = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value * 10) / 10 : undefined;

const word = <T extends string>(value: unknown, words: readonly T[]): T | undefined =>
  words.includes(value as T) ? (value as T) : undefined;

/** Keep only a result's known fields with sane values, so nothing else reaches the log. */
export function cleanCallCheckResult(input: unknown): CallCheckResult | null {
  const raw = (input ?? {}) as Record<string, unknown>;
  const mode = word(raw.mode, CALL_CHECK_MODES);
  const kind = word(raw.kind, ['connect', 'load'] as const);
  const role = word(raw.role, ['caller', 'answerer'] as const);
  if (typeof raw.run !== 'string' || !/^[0-9a-f]{8}$/.test(raw.run) || !mode || !kind || !role) return null;
  const result: CallCheckResult = { run: raw.run, kind, mode, role, connected: raw.connected === true };
  const fields: Partial<CallCheckResult> = {
    failedAt: word(raw.failedAt, STAGES),
    msToConnect: num(raw.msToConnect, 600_000),
    localType: word(raw.localType, CANDIDATE_TYPES),
    remoteType: word(raw.remoteType, CANDIDATE_TYPES),
    rttMs: num(raw.rttMs, 60_000),
    audioDelayMs: num(raw.audioDelayMs, 60_000),
    descriptionBytes: num(raw.descriptionBytes, 1_000_000),
    descriptionSent: num(raw.descriptionSent, 1_000_000),
    descriptionParts: num(raw.descriptionParts, 100),
    streams: num(raw.streams, 16),
    sentFps: num(raw.sentFps, 240),
    receivedFps: num(raw.receivedFps, 240),
    limitedBy: word(raw.limitedBy, LIMITS),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
  }
  return result;
}
