/**
 * What call setup sends over peer signals (ADR 0044 §1, §2). `call.state` goes to the whole
 * Circle every few seconds while a device is in a call; `call.part` carries a compressed offer,
 * answer or goodbye to one member. Both are untrusted until cleaned here.
 */

export const CALL_STATE_TOPIC = 'call.state';
export const CALL_PART_TOPIC = 'call.part';
/** How often a device in a call says so. */
export const CALL_STATE_EVERY_MS = 5_000;
/** A device that hasn't said so for this long has left. */
export const CALL_GONE_MS = 15_000;
/** How long an offer waits for its answer. */
export const CALL_ANSWER_MS = 20_000;
/** How long an answered connection has to connect. */
export const CALL_CONNECT_MS = 20_000;
/** Where a Mac learns its public address (ADR 0044 §9). */
export const CALL_STUN = 'stun:stun.cloudflare.com:3478';

const ROOM = /^[a-z0-9][a-z0-9/_.-]{0,63}$/;
const SESSION = /^[0-9a-f]{16}$/;
const MAX_PEERS = 64;
const MAX_SDP = 65_536;
const MAX_TUNNEL = 0xffffff;

/** One device in a call, as it tells the Circle. `s` is its session id for this join. */
export interface CallState {
  room: string;
  s: string;
  muted: boolean;
  camera: boolean;
  /** How many people this device has connected, 0..64; lets a person's other Mac see the call is live. */
  peers?: number;
  left?: true;
}

/** `s` is the sender's session and `to` the receiver's. */
export type CallMessage =
  | { t: 'offer'; room: string; s: string; to: string; sdp: string; tunnel?: number }
  | { t: 'answer'; room: string; s: string; to: string; sdp: string }
  | { t: 'bye'; room: string; s: string; to: string };

export function isCallRoom(value: unknown): value is string {
  return typeof value === 'string' && ROOM.test(value);
}

function isCallSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION.test(value);
}

export function cleanCallState(value: unknown): CallState | null {
  const raw = value as Partial<CallState> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (!isCallRoom(raw.room) || !isCallSession(raw.s)) return null;
  if (typeof raw.muted !== 'boolean' || typeof raw.camera !== 'boolean') return null;
  const peers = raw.peers;
  const validPeers = typeof peers === 'number' && Number.isInteger(peers) && peers >= 0 && peers <= MAX_PEERS;
  return {
    room: raw.room,
    s: raw.s,
    muted: raw.muted,
    camera: raw.camera,
    ...(validPeers ? { peers } : {}),
    ...(raw.left === true ? { left: true as const } : {}),
  };
}

export function cleanCallMessage(value: unknown): CallMessage | null {
  const raw = value as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null) return null;
  if (!isCallRoom(raw.room) || !isCallSession(raw.s) || !isCallSession(raw.to)) return null;
  const base = { room: raw.room, s: raw.s, to: raw.to };
  if (raw.t === 'bye') return { t: 'bye', ...base };
  if (raw.t !== 'offer' && raw.t !== 'answer') return null;
  if (typeof raw.sdp !== 'string' || raw.sdp.length === 0 || raw.sdp.length > MAX_SDP) return null;
  if (raw.t === 'answer') return { t: 'answer', ...base, sdp: raw.sdp };
  if (raw.tunnel === undefined) return { t: 'offer', ...base, sdp: raw.sdp };
  const tunnel = raw.tunnel;
  if (!Number.isInteger(tunnel) || (tunnel as number) < 1 || (tunnel as number) > MAX_TUNNEL) return null;
  return { t: 'offer', ...base, sdp: raw.sdp, tunnel: tunnel as number };
}
