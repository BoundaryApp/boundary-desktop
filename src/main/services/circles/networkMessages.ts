/**
 * Messages between main and the Circles network utilityProcess (ADR 0032 §1). The process runs
 * the user's Circles (`circles-*`), or, as the phase 0 debug spike, loads the Holepunch modules
 * and replicates one Hypercore.
 */
import type {
  CircleChannel,
  CircleChatUpdate,
  CircleDayUsage,
  CircleLimits,
  CircleMessage,
  CircleMessageRef,
  CirclePublicAddress,
  CircleReadPosition,
  CircleRole,
  CircleServing,
  CirclesSnapshot,
} from '../../../shared/types/circles';

export type { CirclePublicAddress };
import type { CircleMessageShared, CircleOffer, CircleRecord, CircleRecordScope } from './circleOps';
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

/** A record as this device sees it. `confirmed` means a majority of admins' devices have ordered it. */
export interface CircleRecordEntry extends CircleRecord {
  circleKey: string;
  confirmed: boolean;
}

/** A record that appeared, changed, was deleted or was confirmed. `value` is null when deleted. */
export interface CircleRecordChange extends CircleRecordEntry {
  deleted: boolean;
}

/** What a chat request answers with. */
export interface CircleChatReply {
  channels?: CircleChannel[];
  messages?: CircleMessage[];
  /** Older messages exist before the first one returned. */
  more?: boolean;
  /** A posted message's id. */
  id?: string;
}

/** Requests main sends to the running Circles network; each answer carries the same `id`. */
export type CirclesRequest =
  | { op: 'create'; name: string }
  | { op: 'invite'; key: string; expiresAt: number }
  | { op: 'revoke-invite'; key: string; inviteId: string }
  | { op: 'join'; code: string }
  | { op: 'join-cancel' }
  | { op: 'set-role'; key: string; identity: string; role: CircleRole }
  | { op: 'remove-member'; key: string; identity: string }
  | { op: 'leave'; key: string }
  | { op: 'delete'; key: string }
  | { op: 'set-name'; name: string }
  | { op: 'publish-offer'; key: string; offer: CircleOffer }
  | { op: 'withdraw-offer'; key: string }
  | { op: 'record-set'; key: string; app: string; scope: CircleRecordScope; record: string; value: unknown; keep?: boolean }
  | { op: 'record-del'; key: string; app: string; scope: CircleRecordScope; record: string; identity?: string }
  | { op: 'records-list'; key: string; app: string }
  /** Channels with unread counts after this device's read positions, by channel. */
  | { op: 'chat-channels'; key: string; reads: Record<string, CircleReadPosition> }
  /** The newest `limit` messages, or those before `before`. */
  | { op: 'chat-messages'; key: string; channel: string; before?: CircleMessageRef; limit: number }
  | { op: 'chat-post'; key: string; channel: string; text: string; shared?: CircleMessageShared }
  | { op: 'chat-edit'; key: string; channel: string; id: string; text: string }
  | { op: 'chat-delete'; key: string; channel: string; author: string; id: string }
  /** The model server this user's gateway forwards to (ADR 0034 §2); null stops serving. */
  | { op: 'share-upstream'; upstream: GatewayUpstream | null; limits?: CircleLimits }
  /** This device's address as the DHT sees it, for call setup (ADR 0044). */
  | { op: 'public-address' };


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
      /** What members have used today, so a restart doesn't refill their limits. */
      usage?: CircleDayUsage;
    }
  | { type: 'circles-request'; id: number; request: CirclesRequest }
  /** A request for a member's shared model, for the router (ADR 0033 §5). */
  | { type: 'shared-request'; id: number; key: string; provider: string; request: SharedModelCall }
  | { type: 'shared-cancel'; id: number }
  /** A peer signal to send; `to` limits it to one member's identity. */
  | { type: 'signal-send'; key: string; topic: string; payload: unknown; to?: string }
  /** The signal topics main listens to; replaces the previous list. */
  | { type: 'signal-topics'; topics: string[] }
  /** The record apps main listens to; replaces the previous list. */
  | { type: 'record-apps'; apps: string[] }
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
  | {
      type: 'circles-reply';
      id: number;
      ok: true;
      secrets?: CircleSecrets;
      invite?: { id: string; code: string; expires: number };
      records?: CircleRecordEntry[];
      chat?: CircleChatReply;
      address?: CirclePublicAddress;
    }
  | { type: 'circles-reply'; id: number; ok: false; error: string }
  | { type: 'log'; message: string; data?: Record<string, unknown> }
  /** A diagnostics event (metadata only); `at` is the process's wall clock in ms. */
  | { type: 'diag'; at: number; event: string; data: Record<string, unknown> }
  /** A shared-model reply: one head, chunks, then one end. An end with no head means it never reached the provider. */
  | { type: 'shared-head'; id: number; status: number; contentType: string }
  | { type: 'shared-chunk'; id: number; data: Uint8Array }
  | { type: 'shared-end'; id: number; error?: string }
  /** The gateway's counts or queue changed. */
  | { type: 'share-usage'; served?: CircleDayUsage; serving: CircleServing }
  /** A peer signal on a topic main listens to, checked against the Circle's members. */
  | { type: 'signal-received'; signal: CircleSignal }
  /** A change to a record of an app main listens to. */
  | { type: 'record-changed'; change: CircleRecordChange }
  /** New, changed and settled-away messages in one channel. */
  | { type: 'chat-update'; update: CircleChatUpdate }
  /** An admin removed this device from a Circle, which is closed here. Main forgets its secrets. */
  | { type: 'circle-paired'; secrets: CircleSecrets }
  | { type: 'circle-removed'; key: string };
