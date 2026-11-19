/**
 * What the call service writes to the Circles diagnostics log: one `call.connect` when a
 * connection connects and one `call.end` when a connected one ends. Metadata only, with no
 * addresses, names or room names: short session and identity prefixes, the path and candidate
 * types, and numbers.
 */

const SHORT = /^[0-9a-f]{8}$/;
const PATHS = ['direct', 'tunnel'] as const;
const ROLES = ['offer', 'answer'] as const;
const CANDIDATES = ['host', 'srflx', 'prflx', 'relay'] as const;
const CONNECT_NUMBERS = ['ms', 'rttMs'] as const;
const END_NUMBERS = ['seconds', 'pathSwitches', 'lossInPct', 'rttMs', 'kbpsIn', 'kbpsOut', 'freezes'] as const;

export interface CallLogInput {
  kind: 'connect' | 'end';
  /** This device's session, first 8 hex characters. */
  s: string;
  /** The other person's identity, first 8 hex characters. */
  peer: string;
  role?: (typeof ROLES)[number];
  path?: (typeof PATHS)[number];
  localType?: (typeof CANDIDATES)[number];
  remoteType?: (typeof CANDIDATES)[number];
  ms?: number;
  rttMs?: number;
  seconds?: number;
  pathSwitches?: number;
  lossInPct?: number;
  kbpsIn?: number;
  kbpsOut?: number;
  freezes?: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The event name and its fields, or null when the input isn't a call log event. */
export function cleanCallLog(input: unknown): { ev: 'call.connect' | 'call.end'; fields: Record<string, string | number> } | null {
  const raw = input as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (raw.kind !== 'connect' && raw.kind !== 'end') return null;
  if (typeof raw.s !== 'string' || !SHORT.test(raw.s) || typeof raw.peer !== 'string' || !SHORT.test(raw.peer)) return null;
  const fields: Record<string, string | number> = { s: raw.s, peer: raw.peer };
  const word = (key: string, allowed: readonly string[]) => {
    if (typeof raw[key] === 'string' && allowed.includes(raw[key] as string)) fields[key] = raw[key] as string;
  };
  const number = (key: string) => {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) fields[key] = round(value);
  };
  if (raw.kind === 'connect') {
    word('role', ROLES);
    word('path', PATHS);
    word('localType', CANDIDATES);
    word('remoteType', CANDIDATES);
    CONNECT_NUMBERS.forEach(number);
    return { ev: 'call.connect', fields };
  }
  word('path', PATHS);
  END_NUMBERS.forEach(number);
  return { ev: 'call.end', fields };
}
