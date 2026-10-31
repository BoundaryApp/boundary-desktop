/**
 * Messages between main and the Circles network utilityProcess (ADR 0032 §1). The process runs
 * the user's Circles (`circles-*`), or, as the phase 0 debug spike, loads the Holepunch modules
 * and replicates one Hypercore.
 */
import type { CircleRole, CirclesSnapshot } from '../../../shared/types/circles';
import type { CircleOffer } from './circleOps';
import type { CircleSignal } from './circleSignals';
import type { GatewayUpstream } from './inferenceGateway';

/**
 * What the phase 0 spike does once its addons are loaded: nothing more (`load`), create a
 * Hypercore and serve it (`seed`), or fetch the Hypercore with this key (`replicate`).
 */
export type NetworkSpikeMode =
  | { kind: 'load' }
  | { kind: 'seed' }
  | { kind: 'replicate'; key: string };

/** What main keeps for each Circle, encrypted with safeStorage. Hex strings. */
export interface CircleSecrets {
  /** The Circle's Corestore namespace on this device. */
  namespace: string;
  /** The Autobase key; absent only while creating. */
  key?: string;
  encryptionKey?: string;
  /** Last known name, for showing a Circle before its view loads. */
  name?: string;
}

export type { CircleSnapshot, CirclesSnapshot } from '../../../shared/types/circles';

/** Requests main sends to the running Circles network; each answer carries the same `id`. */
export type CirclesRequest =
  | { op: 'create'; name: string }
  | { op: 'invite'; key: string; expiresAt: number }
  | { op: 'revoke-invite'; key: string; inviteId: string }
  | { op: 'join'; code: string }
  | { op: 'set-role'; key: string; identity: string; role: CircleRole }
  | { op: 'remove-member'; key: string; identity: string }
  | { op: 'leave'; key: string }
  | { op: 'set-name'; name: string }
  | { op: 'publish-offer'; key: string; offer: CircleOffer }
  | { op: 'withdraw-offer'; key: string }
  /** The model server this user's gateway forwards to (ADR 0034 §2); null stops serving. */
  | { op: 'share-upstream'; upstream: GatewayUpstream | null };

export type MainToNetwork =
  | {
      type: 'start';
      storageDir: string;
      mode: NetworkSpikeMode;
      /** DHT bootstrap nodes as `host:port`; Hyperswarm's public ones when omitted. */
      bootstrap?: string[];
    }
  | {
      /** Run Circles: the user's seeds (hex), name and the Circles this device belongs to. */
      type: 'circles-start';
      storageDir: string;
      identitySeed: string;
      deviceSeed: string;
      name: string;
      circles: CircleSecrets[];
      bootstrap?: string[];
    }
  | { type: 'circles-request'; id: number; request: CirclesRequest }
  /** A request for a member's shared model, for the router (ADR 0033 §5). */
  | { type: 'shared-request'; id: number; key: string; provider: string; request: SharedModelCall }
  | { type: 'shared-cancel'; id: number }
  /** A peer signal to send; `to` limits it to one member's identity. */
  | { type: 'signal-send'; key: string; topic: string; payload: unknown; to?: string }
  /** The signal topics main listens to; replaces the previous list. */
  | { type: 'signal-topics'; topics: string[] }
  | { type: 'stop' };

/** One call to a shared model's narrow API (ADR 0034 §2). `body` is JSON text. */
export interface SharedModelCall {
  method: string;
  path: string;
  body?: string;
}

export type NetworkToMain =
  /** Native addons the process has loaded, by package name, and the required ones it has not. */
  | { type: 'addons'; loaded: string[]; missing: string[] }
  /** `addons` are the native addons that had loaded when it failed. */
  | { type: 'start-failed'; error: string; addons: string[] }
  | { type: 'stopped' }
  | { type: 'circles-ready'; snapshot: CirclesSnapshot }
  | { type: 'circles-snapshot'; snapshot: CirclesSnapshot }
  /** `secrets` for a Circle created or joined; main stores them. */
  | { type: 'circles-reply'; id: number; ok: true; secrets?: CircleSecrets; invite?: { id: string; code: string; expires: number } }
  | { type: 'circles-reply'; id: number; ok: false; error: string }
  | { type: 'log'; message: string; data?: Record<string, unknown> }
  /** A diagnostics event (metadata only); `at` is the process's wall clock in ms. */
  | { type: 'diag'; at: number; event: string; data: Record<string, unknown> }
  /** A shared-model reply: one head, chunks, then one end. An end with no head means it never reached the provider. */
  | { type: 'shared-head'; id: number; status: number; contentType: string }
  | { type: 'shared-chunk'; id: number; data: Uint8Array }
  | { type: 'shared-end'; id: number; error?: string }
  /** A peer signal on a topic main listens to, checked against the Circle's members. */
  | { type: 'signal-received'; signal: CircleSignal }
  /** An admin removed this device from a Circle, which is closed here. Main forgets its secrets. */
  | { type: 'circle-removed'; key: string };
