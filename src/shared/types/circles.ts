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
  /** The Circle's format; mentions are stored from format 3. */
  format: number;
}

export interface CirclesSnapshot {
  /** This user's identity key; empty until the network process has started. */
  identity: string;
  circles: CircleSnapshot[];
  /**
   * Circles this user left that no admin has confirmed yet. This device stays connected to them,
   * across restarts, until an admin is online to receive the leave.
   */
  leaving?: { key: string; name: string }[];
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

/** A channel in a Circle's chat (ADR 0042 §1). `general` exists in every Circle. */
export interface CircleChannel {
  id: string;
  name: string;
  /** Messages after this device's read position. */
  unread: number;
  /** An unread message mentions this user (and @channel counts when this device's preference says so). */
  mentioned: boolean;
}

/** Names a message everywhere outside the Circle's `apply`; positions change until confirmed. */
export interface CircleMessageRef {
  author: string;
  id: string;
}

/** A read position: the newest message read, with its time for when that message is gone. */
export interface CircleReadPosition extends CircleMessageRef {
  at: number;
  /** Reactions to my messages newer than this have been seen. */
  reactionsAt?: number;
}

/** One emoji on a message: who reacted, in the order the pill shows them (the user first). */
export interface CircleReaction {
  emoji: string;
  count: number;
  mine: boolean;
  people: { identity: string; name: string; left: boolean; at: number }[];
}

/** A Circle chat message as this device sees it (Circle chats spec, the public seam). */
export interface CircleMessage extends CircleMessageRef {
  circleKey: string;
  channel: string;
  /** The author's display name when they posted. */
  name: string;
  /** Which of the author's agents wrote it. */
  agent: { slug: string; name: string } | null;
  /** Empty once deleted. */
  text: string;
  /** The author's clock in milliseconds. */
  at: number;
  /** A majority of admins' devices have ordered it, so its place won't change. */
  confirmed: boolean;
  edited: boolean;
  deleted: 'author' | 'admin' | null;
  /** Where shared text came from. */
  shared: { role: 'user' | 'assistant'; model?: string } | null;
  /** A call's start, and its end once known. */
  call: { id: string; ended?: number } | null;
  /** Who the author mentioned; null when nobody. */
  mentions: CircleMentions | null;
  /** The message this one answers; null when it answers none. */
  reply: CircleMessageRef | null;
  /** Emoji reactions in first-use order; empty when none. */
  reactions: CircleReaction[];
  mine: boolean;
}

/**
 * What changed in one channel in one update. `added` are messages this device sees for the first
 * time since the Circle opened; `gone` were shown unconfirmed and disappeared when the order settled.
 */
export interface CircleChatUpdate {
  circleKey: string;
  channel: string;
  added: CircleMessage[];
  changed: CircleMessage[];
  gone: CircleMessageRef[];
}

/** Typing in a channel, or the newest message read there (ADR 0042 §8). */
export type CircleChatMark = { channel: string } & ({ kind: 'typing' } | { kind: 'read'; ref: CircleMessageRef });

/** A member's typing or read mark, with the Circle and who sent it. */
export type CircleChatPresence = { circleKey: string; from: string } & CircleChatMark;

/** How loud a Circle is on this device. `default` follows the Circle's size (see `resolveNotifyLevel`). */
export type CircleNotifyLevel = 'default' | 'all' | 'mentions' | 'nothing';

/** This device's notification settings for one Circle. Never sent to the Circle. */
export interface CircleNotifyPrefs {
  level: CircleNotifyLevel;
  /** Whether an @channel mention counts as a mention of this user. */
  channelMentions: boolean;
}

/** Device-wide notification switches for Circle chats. */
export interface CircleNotifyGlobal {
  enabled: boolean;
  /** Off: notifications say `New message` or `Mentioned you` instead of showing text. */
  showText: boolean;
}

/** Who a message mentions: member identities (64-hex) and/or the whole channel. */
export interface CircleMentions {
  members: string[];
  channel: boolean;
}

/** The DHT's view of this device's public address (ADR 0044). `host` is null until the DHT knows it. */
export interface CirclePublicAddress {
  host: string | null;
  port: number;
  firewalled: boolean;
  randomizedNat: boolean;
}

/**
 * Direct messages (ADR 0054): kept only on the two Macs, sent as peer signals. `delivery` is null
 * for a message from the other person; for one of this user's, `waiting` means the other person's
 * device isn't connected, `sending` that it is and hasn't acknowledged yet, and `undelivered`
 * that the conversation ended before it was acknowledged.
 */
export type DirectDelivery = 'waiting' | 'sending' | 'delivered' | 'undelivered';

export interface DirectMessage {
  id: string;
  author: string;
  mine: boolean;
  /** Empty once deleted. */
  text: string;
  /** The sender's clock in milliseconds; shown, never used for order. */
  at: number;
  reply: CircleMessageRef | null;
  edited: boolean;
  deleted: boolean;
  delivery: DirectDelivery | null;
  /** The user's message is still on this Mac only: deleting it means it is never sent. */
  neverSent: boolean;
}

/** One person's conversation with this user in one Circle. */
export interface DirectConversation {
  /** The other person's identity key. */
  peer: string;
  name: string;
  online: boolean;
  /** They left or were removed: the conversation is read-only. */
  ended: boolean;
  last: { at: number; text: string; mine: boolean; deleted: boolean } | null;
  /** This user's messages still in the outbox. */
  waiting: number;
  /** The other person's messages after this device's read position. Never leaves this Mac. */
  unread: number;
}

export type DirectEvent =
  /** A message from the other person arrived on this device for the first time. */
  | { kind: 'message'; circleKey: string; peer: string; message: DirectMessage }
  /** A message was sent, edited, deleted or delivered. */
  | { kind: 'change'; circleKey: string; peer: string; message: DirectMessage }
  /** One of this user's messages was deleted before it was ever sent. */
  | { kind: 'unsent'; circleKey: string; peer: string; id: string }
  | { kind: 'typing'; circleKey: string; peer: string }
  /** The other person left or was removed. */
  | { kind: 'ended'; circleKey: string; peer: string }
  /** They are a member again, with the same identity, so the conversation carries on. */
  | { kind: 'reopened'; circleKey: string; peer: string }
  /** This device read the conversation up to a message, so its unread count changed. */
  | { kind: 'read'; circleKey: string; peer: string };
