/** What the renderer sees of the user's Circles (ADR 0032). Keys are hex. */

export type CircleRole = 'admin' | 'member';

export interface CircleMemberView {
  /** The person's identity key, the same in every Circle they belong to. */
  identity: string;
  name: string;
  role: CircleRole;
  isMe: boolean;
  /** Connected to this device now. Always true for yourself. */
  online: boolean;
}

export interface CircleInviteView {
  id: string;
  /** Milliseconds since the epoch. */
  expires: number;
  revoked: boolean;
  used: boolean;
}

/** A model a member shares with a Circle (ADR 0034 §1). */
export interface SharedModelOffer {
  /** The model id the provider's server knows it by. */
  id: string;
  contextLength?: number;
  /** Whether the model handles tool calls. */
  tools: boolean;
}

export interface CircleOfferView {
  /** The provider's identity key. */
  identity: string;
  name: string;
  isMine: boolean;
  models: SharedModelOffer[];
  available: boolean;
  away: boolean;
  /** Connected to this device now; always true for your own offer. */
  online: boolean;
}

export interface CircleSnapshot {
  key: string;
  name: string;
  /** Null while joining, before the Circle's members have reached this device. */
  myRole: CircleRole | null;
  members: CircleMemberView[];
  invites: CircleInviteView[];
  /** Members' shared models, one offer per member who shares. */
  offers: CircleOfferView[];
  /** The Circle moved to a format this build can't apply; it stays stopped until the app updates. */
  needsUpdate: boolean;
  /** False from admission until this device has caught up, and read-only until then. */
  writable: boolean;
}

export interface CirclesSnapshot {
  /** This user's identity key; empty until the network process has started. */
  identity: string;
  circles: CircleSnapshot[];
}

/**
 * What the user accepts from one provider, whichever Circle they share through (ADR 0034 §3).
 * Neither can be checked; each is the user's claim about a person.
 */
export interface CircleProviderSettings {
  /** "I accept that this person can read my prompts": their models may serve private projects. */
  private: boolean;
  /** "I accept that this person's model can run my agent's tools." */
  trusted: boolean;
}

/** What this user shares from their local model server (ADR 0034 §1, §4). */
export interface CircleSharing {
  /** Models offered, from the local slot's server. Empty shares nothing. */
  models: SharedModelOffer[];
  /** Keys of the Circles to share with. */
  circles: string[];
  /** Offers stay published but say unavailable, and the gateway refuses requests. */
  paused: boolean;
  /** Keep the Mac awake while Boundary is open, so members can use the models while you're away. */
  away: boolean;
  /** Off until the user sets one (ADR 0034 §5). */
  limits?: CircleLimits;
}

/** What one member may use; a field left out has no limit. */
export interface CircleLimit {
  requestsPerDay?: number;
  tokensPerDay?: number;
  /** Requests running or waiting at once. */
  concurrent?: number;
}

export interface CircleLimits {
  everyone: CircleLimit;
  /** By identity, across all Circles. Replaces `everyone` for that member. */
  members: Record<string, CircleLimit>;
}

export interface CircleUsageCount {
  requests: number;
  tokens: number;
}

/** One calendar day's counts, by identity. */
export interface CircleDayUsage {
  day: string;
  counts: Record<string, CircleUsageCount>;
}

/** Who the gateway is working for now, by identity, in order. */
export interface CircleServing {
  running: string | null;
  queued: string[];
}

/** A join in progress, or the failure of the last one until the user clears it. */
export interface CircleJoinState {
  /** Waiting for an admin's device to let this device in. */
  waiting: boolean;
  error?: string;
}

export interface CirclesState {
  /** `stopped` until Circles are first used; `failed` carries `error`. */
  status: 'stopped' | 'starting' | 'running' | 'failed';
  error?: string;
  /** The name other members see. */
  displayName: string;
  snapshot: CirclesSnapshot;
  /** By provider identity; a provider with no entry is neither private nor trusted. */
  providers: Record<string, CircleProviderSettings>;
  sharing: CircleSharing;
  /** What the user called each invite, by invite id. Stays on this device. */
  inviteLabels?: Record<string, string>;
  /** Invites whose code this device keeps. Ids only: the codes stay in main. */
  inviteCodeIds?: string[];
  join?: CircleJoinState | null;
  /** The Circle a join has been admitted to, until the wait for write access ends. */
  finishingJoin?: string | null;
  /** What members used of this user's models today. Stays on this device. */
  served?: CircleDayUsage;
  serving?: CircleServing | null;
  /** What this user used of each provider's models today. Stays on this device. */
  used?: CircleDayUsage;
}

export interface CircleCreatedInvite {
  id: string;
  code: string;
  expires: number;
  /** This device kept the code, so the sheet can show it again. */
  kept: boolean;
  /** Earlier invites with this name that couldn't be revoked. */
  stillOpen: number;
}

export type CirclesResult<T extends object = object> =
  | ({ success: true; state: CirclesState } & T)
  | { success: false; error: string; state: CirclesState };
