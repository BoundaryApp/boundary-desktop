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
import type { CircleMessageMentions, CircleMessageShared, CircleOffer, CircleRecord, CircleRecordScope } from './circleOps';
import type { CircleSignal } from './circleSignals';
import type { CallCheckResult, CallTunnelStats } from '../../../shared/callCheck';
import type { GatewayUpstream } from './inferenceGateway';
import type { ServiceRequest, ServiceUpstream } from './serviceGateway';
import type { FolderDeviceIntro, FolderRole } from './folderOps';
import type { FolderSummary } from './folderRuntime';
import type { FolderSecrets } from './sharedFolders';
import type { SharedFolderChange, SharedFolderConflict, SharedFolderFile } from '../../../shared/types/sharedFolders';

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
  /** This user left and an admin hasn't confirmed it yet. Main keeps this apart from the secrets. */
  leaving?: boolean;
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
  /** One message by reference; null when the view doesn't hold it. */
  message?: CircleMessage | null;
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
  | { op: 'chat-channels'; key: string; reads: Record<string, CircleReadPosition>; channelMentions: boolean }
  /** The newest `limit` messages, or those before `before`. */
  | { op: 'chat-messages'; key: string; channel: string; before?: CircleMessageRef; limit: number }
  | { op: 'chat-post'; key: string; channel: string; text: string; shared?: CircleMessageShared; mentions?: CircleMessageMentions; reply?: CircleMessageRef }
  /** One message by reference; `chat.message` is null when this view doesn't hold it. */
  | { op: 'chat-message'; key: string; channel: string; ref: CircleMessageRef }
  | { op: 'chat-edit'; key: string; channel: string; id: string; text: string; mentions?: CircleMessageMentions }
  | { op: 'chat-delete'; key: string; channel: string; author: string; id: string }
  /** Add or take back this user's emoji reaction on a message (ADR 0057). */
  | { op: 'chat-react'; key: string; channel: string; author: string; id: string; emoji: string; on: boolean }
  /** The services this user shares and the members granted each (ADR 0048 §4); replaces the last. */
  | { op: 'service-sharing'; sharing: ServiceSharing }
  /** The model server this user's gateway forwards to (ADR 0034 §2); null stops serving. */
  | { op: 'share-upstream'; upstream: GatewayUpstream | null; limits?: CircleLimits }
  /** This device's address as the DHT sees it, for call setup (ADR 0044). */
  | { op: 'public-address' }
  /** A call tunnel to one member (call check tunnel modes): open it, read its counts, or close it. */
  | { op: 'call-tunnel'; action: CallTunnelAction; key: string; to: string; tunnel: number; device?: string }
  /** The DHT's view of this network and the Circles connection to one member, for a check result. */
  | { op: 'call-context'; key: string; to: string }
  | FolderRequest;

/** Requests about shared folders (ADR 0049); `key` is the folder's key. */
export type FolderRequest =
  | { op: 'folder-create'; name: string; role: Exclude<FolderRole, 'manager'> }
  /** Open a folder this device created or was offered, so it replicates. */
  | { op: 'folder-open'; folder: FolderSecrets }
  /** Stop replicating a folder this device removed. */
  | { op: 'folder-close'; key: string }
  /** This device's signed intro, for a manager to add it as a writer. */
  | { op: 'folder-intro'; key: string }
  | { op: 'folder-add-writer'; key: string; intro: FolderDeviceIntro }
  | { op: 'folder-set-role'; key: string; identity: string; role: FolderRole; name?: string }
  | { op: 'folder-remove-person'; key: string; identity: string }
  | { op: 'folder-mirror'; key: string; root: string }
  /** `forget` drops what the mirror knew, for a folder removed from this Mac. */
  | { op: 'folder-unmirror'; key: string; forget: boolean }
  | { op: 'folder-summary'; key: string }
  /** The files in the folder's current view, without deleted ones. */
  | { op: 'folder-files'; key: string }
  /** File changes newest first: one file's versions, or every file's. */
  | { op: 'folder-history'; key: string; path?: string }
  /** Write an older version of `path` back as a new change. */
  | { op: 'folder-restore'; key: string; path: string; seq: number }
  | { op: 'folder-compare'; key: string; copy: string }
  /** Settle a conflict copy: keep the original, keep the copy in its place, or keep both. */
  | { op: 'folder-resolve'; key: string; copy: string; keep: 'original' | 'copy' | 'both' };

/** What a folder request answers with. */
export interface FolderReply {
  folder?: FolderSecrets;
  intro?: FolderDeviceIntro;
  summary?: FolderSummary;
  files?: SharedFolderFile[];
  history?: SharedFolderChange[];
  conflict?: SharedFolderConflict;
}

/**
 * One member's keys for one service in one Circle. Main keeps these encrypted; the network
 * process holds them in memory only, for the gateway to swap in.
 */
export interface ServiceGrantEntry {
  circle: string;
  service: string;
  identity: string;
  read: string;
  write?: string;
}

/** What this user's service gateway serves, by service id. */
export interface ServiceSharing {
  upstreams: Record<string, ServiceUpstream>;
  grants: ServiceGrantEntry[];
}

/** Added to each call check result by main. Address classes only, never addresses. */
export type CallContext = Pick<
  CallCheckResult,
  'natFirewalled' | 'natRandomized' | 'peerConnected' | 'peerAddr' | 'peerRttMs' | 'peerRetransmits' | 'peerAgeS' | 'peerMtu'
>;

export type CallTunnelAction = 'open' | 'stats' | 'close';

/** A call tunnel reply: the port after `open`, the counts after `stats` or `close`. */
export interface CallTunnelReply {
  port?: number;
  stats?: CallTunnelStats | null;
}


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
      /** What members have used of this user's services today. */
      serviceUsage?: CircleDayUsage;
    }
  | { type: 'circles-request'; id: number; request: CirclesRequest }
  /** A request for a member's shared model, for the router (ADR 0033 §5). */
  | { type: 'shared-request'; id: number; key: string; provider: string; request: SharedModelCall }
  /**
   * A call to a service a member shares (ADR 0048 §3), for this Mac's listener. Its reply comes
   * back as `shared-head`, `shared-chunk` and `shared-end`, and `shared-cancel` stops it.
   */
  | { type: 'service-request'; id: number; key: string; provider: string; request: ServiceCall }
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

/** One call to a member's shared service, without the ids the network process adds. */
export type ServiceCall = Omit<ServiceRequest, 'id' | 'circle'>;

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
      tunnel?: CallTunnelReply;
      context?: CallContext;
      folders?: FolderReply;
    }
  | { type: 'circles-reply'; id: number; ok: false; error: string }
  | { type: 'log'; message: string; data?: Record<string, unknown> }
  /** A diagnostics event (metadata only); `at` is the process's wall clock in ms. */
  | { type: 'diag'; at: number; event: string; data: Record<string, unknown> }
  /** A shared-model reply: one head, chunks, then one end. An end with no head means it never reached the provider. */
  | { type: 'shared-head'; id: number; status: number; contentType: string }
  | { type: 'shared-chunk'; id: number; data: Uint8Array }
  | { type: 'shared-end'; id: number; error?: string }
  /** What members used of this user's services today changed. */
  | { type: 'service-usage'; served: CircleDayUsage }
  /** The gateway's counts or queue changed. */
  | { type: 'share-usage'; served?: CircleDayUsage; serving: CircleServing }
  /** A peer signal on a topic main listens to, checked against the Circle's members. */
  | { type: 'signal-received'; signal: CircleSignal }
  /** A change to a record of an app main listens to. */
  | { type: 'record-changed'; change: CircleRecordChange }
  /** New, changed and settled-away messages in one channel. */
  | { type: 'chat-update'; update: CircleChatUpdate }
  /** A Circle was paired or joined here; main keeps its secrets. */
  | { type: 'circle-paired'; secrets: CircleSecrets }
  /** An admin removed this device from a Circle, which is closed here. Main forgets its secrets. */
  | { type: 'circle-removed'; key: string }
  | { type: 'member-left'; key: string; circle: string; name: string }
  /** A shared folder's view or its mirror changed; main asks for a summary when it needs one. */
  | { type: 'folder-changed'; key: string };
