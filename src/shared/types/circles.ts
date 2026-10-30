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
}

export type CirclesResult<T extends object = object> =
  | ({ success: true; state: CirclesState } & T)
  | { success: false; error: string; state: CirclesState };
