/**
 * What a Circle's Autobase holds and how its operations apply (ADR 0032 §3–§5). This runs inside
 * Autobase's `apply`, on every peer, in the order the indexers settle on, so it must be
 * deterministic: no clock, no randomness, nothing outside the view. An operation its author may
 * not perform is skipped, never thrown on, so one bad entry can't stop the Circle.
 *
 * What an operation does at a format never changes, because anyone joining replays the whole log.
 * A later build adds or changes one behind a new format (ADR 0038).
 *
 * Kept free of native modules so it can be tested on its own; the signature check is passed in.
 */

import type { SharedModelOffer } from '../../../shared/types/circles';

export type CircleRole = 'admin' | 'member';

/** The highest format this build can apply. New Circles start at it. */
export const CIRCLE_FORMAT = 2;

/** The first format with chat and kept records (ADR 0042 §1–§2). */
export const CHAT_FORMAT = 2;

/** How a device introduces its owner to a Circle. Hex strings throughout. */
export interface CircleMemberIntro {
  /** The person's identity key; the same in every Circle they belong to (ADR 0032 §2). */
  identity: string;
  name: string;
  /** The device's writer core for this Circle. */
  writer: string;
  /** The device key, which is also its swarm key, so peers can tell who is connected. */
  device: string;
  /** The identity's signature over `device ‖ writer`. */
  signature: string;
}

export interface CircleMemberRecord extends CircleMemberIntro {
  role: CircleRole;
}

export interface CircleInviteRecord {
  /** blind-pairing's invite id. */
  id: string;
  /** Opens the candidate's request (blind-pairing). */
  publicKey: string;
  /** Milliseconds since the epoch; checked by the admin's device before it adds anyone. */
  expires: number;
  createdBy: string;
  revoked?: boolean;
  /** The identity that joined with it. An invite is good for one person. */
  usedBy?: string;
}

/** What a member offers. Whether they are reachable comes from the swarm, not from here. */
export interface CircleOffer {
  models: SharedModelOffer[];
  /** Off while the provider has paused sharing without withdrawing the offer. */
  available: boolean;
  /** The provider keeps their Mac awake to serve while away (ADR 0034 §4). */
  away: boolean;
}

export interface CircleOfferRecord extends CircleOffer {
  identity: string;
}

export type CircleRecordScope = 'circle' | 'member';

/** What a Circle keeps for a feature. Peers replicate it whether or not they know the `app`. */
export interface CircleRecord {
  app: string;
  scope: CircleRecordScope;
  /** The member it belongs to; null for a `circle` record. */
  identity: string | null;
  key: string;
  /** JSON. `apply` checks its size and never reads it, so readers must not trust it. */
  value: unknown;
  /** A `member` record that stays after its member leaves, until an admin deletes it. Format 2. */
  keep?: true;
}

/** Where shared text came from (ADR 0042 §9). */
export interface CircleMessageShared {
  role: 'user' | 'assistant';
  /** The model name the Hermes chat showed, for an assistant reply. */
  model?: string;
}

/** Which of the author's agents wrote a message (ADR 0042 §12). A label, not a separate identity. */
export interface CircleMessageAgent {
  slug: string;
  name: string;
}

/** A call's start, and its end once the author's device saw it (ADR 0044 §7). */
export interface CircleMessageCall {
  id: string;
  /** The author's clock in milliseconds. */
  ended?: number;
}

/** A message as the view holds it. */
export interface CircleMessageRecord {
  channel: string;
  /** Its place in the channel. Recomputed when unconfirmed entries reorder, so never an identity. */
  position: number;
  /** The author's identity. With `id`, names the message everywhere outside `apply`. */
  author: string;
  id: string;
  /** The author's display name when they posted, kept after they leave. */
  name: string;
  /** Empty once deleted. */
  text: string;
  /** The author's clock in milliseconds; shown, never used for order. */
  at: number;
  edited: boolean;
  /** Who removed it: its author, or an admin. */
  deleted: 'author' | 'admin' | null;
  shared?: CircleMessageShared;
  agent?: CircleMessageAgent;
  call?: CircleMessageCall;
}

export type CircleOp =
  | { type: 'create'; name: string; format: number; member: CircleMemberIntro }
  | { type: 'set-format'; format: number }
  | { type: 'add-member'; member: CircleMemberIntro; invite: string }
  | { type: 'set-role'; identity: string; role: CircleRole }
  | { type: 'remove-member'; identity: string }
  | { type: 'invite'; invite: Pick<CircleInviteRecord, 'id' | 'publicKey' | 'expires'> }
  | { type: 'revoke-invite'; id: string }
  | { type: 'offer'; offer: CircleOffer }
  | { type: 'withdraw-offer' }
  | { type: 'record-set'; app: string; scope: CircleRecordScope; key: string; value: unknown; keep?: true }
  | { type: 'record-del'; app: string; scope: CircleRecordScope; key: string; identity?: string }
  | {
      type: 'chat-post';
      channel: string;
      id: string;
      text: string;
      at: number;
      shared?: CircleMessageShared;
      agent?: CircleMessageAgent;
      call?: CircleMessageCall;
    }
  | { type: 'chat-edit'; channel: string; id: string; text: string; call?: CircleMessageCall }
  | { type: 'chat-delete'; channel: string; author: string; id: string };

/** The view's `CIRCLE_KEY` entry. */
export interface CircleHeader {
  name: string;
  /** Which rules apply to this Circle. Only rises (ADR 0038). */
  format: number;
}

/** View keys. */
export const CIRCLE_KEY = 'circle';
export const memberKey = (identity: string): string => `members/${identity}`;
const writerKey = (writer: string): string => `writers/${writer}`;
export const inviteKey = (id: string): string => `invites/${id}`;
export const offerKey = (identity: string): string => `offers/${identity}`;
export const MEMBERS_PREFIX = 'members/';
export const INVITES_PREFIX = 'invites/';
export const OFFERS_PREFIX = 'offers/';
export const RECORDS_PREFIX = 'records/';
const memberRecordsPrefix = (identity: string): string => `${RECORDS_PREFIX}member/${identity}/`;
export const circleRecordKey = (app: string, key: string): string => `${RECORDS_PREFIX}circle/${app}/${key}`;
export const memberRecordKey = (identity: string, app: string, key: string): string =>
  `${memberRecordsPrefix(identity)}${app}/${key}`;
const CHAT_PREFIX = 'chat/';
/** A channel's message count. */
export const chatCountKey = (channel: string): string => `${CHAT_PREFIX}${channel}/count`;
/** Positions are zero-padded so a channel's messages list in order. */
export const chatMessageKey = (channel: string, position: number): string =>
  `${CHAT_PREFIX}${channel}/messages/${String(position).padStart(12, '0')}`;
/** From `author/id` to the message's position. */
export const chatIndexKey = (channel: string, author: string, id: string): string =>
  `${CHAT_PREFIX}${channel}/ids/${author}/${id}`;

/**
 * Whether a view update took away this device's own membership. A member who left and joined
 * again has a new writer, and catching up replays their old record and its removal, so a record
 * only counts as theirs when it holds their current writer.
 */
export function lostMembership(
  before: CircleMemberRecord[],
  after: CircleMemberRecord[],
  self: { identity: string; writer: string }
): boolean {
  return !after.some((member) => member.identity === self.identity) && before.some((member) => member.writer === self.writer);
}

/** The parts of Hyperbee that apply uses. */
export interface CircleViewStore {
  get(key: string): Promise<{ value: unknown } | null>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

/** The parts of Autobase's host calls that apply uses. */
export interface CircleHost {
  addWriter(key: Buffer, opts: { indexer: boolean }): Promise<void>;
  removeWriter(key: Buffer): Promise<void>;
  removeable(key: Buffer): boolean;
  /** Stops applying here until a build that can continue reopens the Circle. Throws. */
  interrupt(reason: string): void;
}

export interface CircleNode {
  value: unknown;
  from: { key: Buffer };
}

export interface CircleApplyDeps {
  /** ed25519 verify over raw bytes. */
  verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean;
  /** The highest format to apply; `CIRCLE_FORMAT` unless a test stands in for another build. */
  supportedFormat?: number;
  /** Called with each skipped operation and why, for the debug log. */
  onSkip?(reason: string, op: unknown): void;
  /**
   * Called when `remove-member` applies, with whether the member removed themselves. Autobase
   * reapplies reordered entries and a new device replays history, so it can fire more than once.
   */
  onRemoveMember?(identity: string, byThemselves: boolean): void;
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const MAX_NAME = 80;
const MAX_OFFERED_MODELS = 32;
const MAX_MODEL_ID = 200;
const MAX_CONTEXT = 100_000_000;
/** The longest record value, as JSON text. */
export const MAX_RECORD_VALUE_BYTES = 16 * 1024;
const RECORD_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MESSAGE_ID = /^[0-9a-f]{16,32}$/;
/** The longest message text, as UTF-8. */
const MAX_MESSAGE_TEXT_BYTES = 12 * 1024;
/** The longest chat operation, as JSON text. */
const MAX_CHAT_OP_BYTES = 16 * 1024;
const MAX_MODEL_NAME = 200;

/** An `app` or record `key`. Neither can hold a `/`, so view keys stay unambiguous. */
export const isRecordName = (name: unknown): name is string => typeof name === 'string' && RECORD_NAME.test(name);

export const isRecordScope = (scope: unknown): scope is CircleRecordScope => scope === 'circle' || scope === 'member';

/** Whether `value` can be stored: JSON text within the limit. */
export function isRecordValue(value: unknown): boolean {
  const json = JSON.stringify(value);
  return json !== undefined && Buffer.byteLength(json) <= MAX_RECORD_VALUE_BYTES;
}

/** The bytes an identity signs to vouch for a device's writer in one Circle. */
export function deviceProofMessage(device: string, writer: string): Buffer {
  return Buffer.concat([Buffer.from(device, 'hex'), Buffer.from(writer, 'hex')]);
}

function isIntro(value: unknown): value is CircleMemberIntro {
  const intro = value as CircleMemberIntro;
  return (
    typeof intro === 'object' &&
    intro !== null &&
    HEX_KEY.test(intro.identity) &&
    HEX_KEY.test(intro.writer) &&
    HEX_KEY.test(intro.device) &&
    HEX_SIGNATURE.test(intro.signature) &&
    typeof intro.name === 'string' &&
    intro.name.trim().length > 0 &&
    intro.name.length <= MAX_NAME
  );
}

/** A well-formed intro whose identity really signed this device and writer. */
export function introIsValid(value: unknown, deps: Pick<CircleApplyDeps, 'verify'>): value is CircleMemberIntro {
  if (!isIntro(value)) return false;
  try {
    return deps.verify(
      deviceProofMessage(value.device, value.writer),
      Buffer.from(value.signature, 'hex'),
      Buffer.from(value.identity, 'hex')
    );
  } catch {
    return false;
  }
}

/** A well-formed offer, cut to its known fields; null when it isn't one. */
function cleanOffer(value: unknown): CircleOffer | null {
  const offer = value as CircleOffer;
  if (typeof offer !== 'object' || offer === null || !Array.isArray(offer.models)) return null;
  if (offer.models.length > MAX_OFFERED_MODELS) return null;
  if (typeof offer.available !== 'boolean' || typeof offer.away !== 'boolean') return null;
  const models: SharedModelOffer[] = [];
  const seen = new Set<string>();
  for (const model of offer.models as unknown[]) {
    const { id, contextLength, tools } = (model ?? {}) as SharedModelOffer;
    if (typeof id !== 'string' || !id.trim() || id.length > MAX_MODEL_ID || seen.has(id)) return null;
    if (typeof tools !== 'boolean') return null;
    if (
      contextLength !== undefined &&
      (!Number.isInteger(contextLength) || contextLength <= 0 || contextLength > MAX_CONTEXT)
    ) {
      return null;
    }
    seen.add(id);
    models.push({ id, tools, ...(contextLength !== undefined ? { contextLength } : {}) });
  }
  return { models, available: offer.available, away: offer.away };
}

export const isMessageId = (id: unknown): id is string => typeof id === 'string' && MESSAGE_ID.test(id);

/** Whether `text` fits; it may be empty only when the message marks a call. */
export function isMessageText(text: unknown, call: boolean): text is string {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MESSAGE_TEXT_BYTES) return false;
  return call || text.trim().length > 0;
}

/** The optional parts of a message, cut to their known fields; null when one is malformed. */
function cleanMessageParts(op: {
  shared?: unknown;
  agent?: unknown;
  call?: unknown;
}): Pick<CircleMessageRecord, 'shared' | 'agent' | 'call'> | null {
  const parts: Pick<CircleMessageRecord, 'shared' | 'agent' | 'call'> = {};
  if (op.shared !== undefined) {
    const { role, model } = (op.shared ?? {}) as CircleMessageShared;
    if (role !== 'user' && role !== 'assistant') return null;
    if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > MAX_MODEL_NAME)) return null;
    parts.shared = { role, ...(model !== undefined ? { model } : {}) };
  }
  if (op.agent !== undefined) {
    const { slug, name } = (op.agent ?? {}) as CircleMessageAgent;
    if (!isRecordName(slug) || typeof name !== 'string' || !name.trim() || name.length > MAX_NAME) return null;
    parts.agent = { slug, name: name.trim() };
  }
  if (op.call !== undefined) {
    const call = cleanCall(op.call);
    if (!call) return null;
    parts.call = call;
  }
  return parts;
}

function cleanCall(value: unknown): CircleMessageCall | null {
  const { id, ended } = (value ?? {}) as CircleMessageCall;
  if (!isMessageId(id)) return null;
  if (ended !== undefined && (!Number.isSafeInteger(ended) || ended < 0)) return null;
  return { id, ...(ended !== undefined ? { ended } : {}) };
}

const fitsChatOp = (op: unknown): boolean => Buffer.byteLength(JSON.stringify(op)) <= MAX_CHAT_OP_BYTES;

function introOnly(intro: CircleMemberIntro): CircleMemberIntro {
  const { identity, name, writer, device, signature } = intro;
  return { identity, name: name.trim(), writer, device, signature };
}

const isFormat = (format: unknown): format is number => Number.isInteger(format) && (format as number) >= 1;

async function read<T>(view: CircleViewStore, key: string): Promise<T | null> {
  const node = await view.get(key);
  return node ? (node.value as T) : null;
}

export type CircleView = CircleViewStore & {
  /** Values under a key prefix. */
  list(prefix: string): Promise<unknown[]>;
};

/** Admins left besides `except`. Members are few, so a scan is fine. */
async function otherAdmins(view: CircleView, except: string): Promise<number> {
  const members = (await view.list(MEMBERS_PREFIX)) as CircleMemberRecord[];
  return members.filter((member) => member.role === 'admin' && member.identity !== except).length;
}

/** Apply a batch of Circle operations to the view (Autobase's `apply`). */
export async function applyCircleNodes(
  nodes: CircleNode[],
  view: CircleView,
  host: CircleHost,
  deps: CircleApplyDeps
): Promise<void> {
  for (const node of nodes) {
    // Ack nodes carry null.
    if (node.value === null || node.value === undefined) continue;
    const reason = await applyOne(node, view, host, deps);
    if (reason) deps.onSkip?.(reason, node.value);
  }
}

/** Applies one operation, or returns why it was skipped. */
async function applyOne(
  node: CircleNode,
  view: CircleView,
  host: CircleHost,
  deps: CircleApplyDeps
): Promise<string | null> {
  const op = node.value as CircleOp;
  const from = node.from.key.toString('hex');
  const circle = await read<CircleHeader>(view, CIRCLE_KEY);
  const supported = deps.supportedFormat ?? CIRCLE_FORMAT;

  if (op.type === 'create') {
    if (circle) return 'the Circle already exists';
    if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > MAX_NAME) return 'bad name';
    if (!isFormat(op.format)) return 'bad format';
    // The creator's device is the bootstrap writer and already an indexer.
    if (!introIsValid(op.member, deps) || op.member.writer !== from) return 'bad creator intro';
    if (op.format > supported) host.interrupt(`Circle format ${op.format}`);
    await view.put(CIRCLE_KEY, { name: op.name.trim(), format: op.format });
    await view.put(memberKey(op.member.identity), { ...introOnly(op.member), role: 'admin' });
    await view.put(writerKey(from), { identity: op.member.identity });
    return null;
  }
  if (!circle) return 'the Circle has not been created';

  const author = await read<{ identity: string }>(view, writerKey(from));
  const authorMember = author ? await read<CircleMemberRecord>(view, memberKey(author.identity)) : null;
  // A writer whose member was removed or replaced by a newer device can't act.
  const authorRole = authorMember && authorMember.writer === from ? authorMember.role : null;

  switch (op.type) {
    case 'set-format': {
      // Admin-only because it halts older builds: anything a member appends must only be skipped.
      if (authorRole !== 'admin') return 'only admins change the format';
      if (!isFormat(op.format) || op.format <= circle.format) return 'bad format';
      if (op.format > supported) host.interrupt(`Circle format ${op.format}`);
      await view.put(CIRCLE_KEY, { ...circle, format: op.format });
      return null;
    }
    case 'invite': {
      if (authorRole !== 'admin') return 'only admins invite';
      const { id, publicKey, expires } = op.invite ?? ({} as CircleInviteRecord);
      if (!HEX_KEY.test(id) || !HEX_KEY.test(publicKey) || typeof expires !== 'number') return 'bad invite';
      if (await view.get(inviteKey(id))) return 'invite exists';
      await view.put(inviteKey(id), { id, publicKey, expires, createdBy: author!.identity });
      return null;
    }
    case 'revoke-invite': {
      if (authorRole !== 'admin') return 'only admins revoke invites';
      const invite = await read<CircleInviteRecord>(view, inviteKey(op.id));
      if (!invite) return 'no such invite';
      await view.put(inviteKey(op.id), { ...invite, revoked: true });
      return null;
    }
    case 'add-member': {
      if (authorRole !== 'admin') return 'only admins add members';
      const invite = await read<CircleInviteRecord>(view, inviteKey(op.invite));
      // Expiry is checked by the admin's device before it appends; apply has no clock.
      if (!invite || invite.revoked || invite.usedBy) return 'invite not usable';
      if (!introIsValid(op.member, deps)) return 'bad member intro';
      if (await view.get(writerKey(op.member.writer))) return 'writer already in use';
      const prior = await read<CircleMemberRecord>(view, memberKey(op.member.identity));
      if (prior) {
        // The same person on a new device replaces the old one, keeping their role.
        if (host.removeable(Buffer.from(prior.writer, 'hex'))) await host.removeWriter(Buffer.from(prior.writer, 'hex'));
        await view.del(writerKey(prior.writer));
      }
      const role: CircleRole = prior?.role ?? 'member';
      await host.addWriter(Buffer.from(op.member.writer, 'hex'), { indexer: role === 'admin' });
      await view.put(memberKey(op.member.identity), { ...introOnly(op.member), role });
      await view.put(writerKey(op.member.writer), { identity: op.member.identity });
      await view.put(inviteKey(invite.id), { ...invite, usedBy: op.member.identity });
      return null;
    }
    case 'set-role': {
      if (authorRole !== 'admin') return 'only admins change roles';
      if (op.role !== 'admin' && op.role !== 'member') return 'bad role';
      const target = await read<CircleMemberRecord>(view, memberKey(op.identity));
      if (!target) return 'no such member';
      if (target.role === op.role) return null;
      if (op.role === 'member' && (await otherAdmins(view, target.identity)) === 0) return 'the last admin stays admin';
      // Admins index; members only write (ADR 0032 §4).
      await host.addWriter(Buffer.from(target.writer, 'hex'), { indexer: op.role === 'admin' });
      await view.put(memberKey(target.identity), { ...target, role: op.role });
      return null;
    }
    case 'remove-member': {
      const target = await read<CircleMemberRecord>(view, memberKey(op.identity));
      if (!target) return 'no such member';
      // Admins remove anyone; a member may remove themselves (leaving).
      if (authorRole !== 'admin' && author?.identity !== op.identity) return 'only admins remove others';
      if (authorRole === null) return 'not a member';
      if (target.role === 'admin' && (await otherAdmins(view, target.identity)) === 0) return 'the last admin cannot leave';
      const writer = Buffer.from(target.writer, 'hex');
      if (!host.removeable(writer)) return 'Autobase will not remove that writer';
      await host.removeWriter(writer);
      deps.onRemoveMember?.(target.identity, author?.identity === op.identity);
      await view.del(memberKey(target.identity));
      await view.del(writerKey(target.writer));
      // A member who leaves stops sharing too (ADR 0033 §10: their entries go stale).
      await view.del(offerKey(target.identity));
      // Kept records outlive their member from format 2 (ADR 0042 §2); messages always do (§7).
      const records = (await view.list(memberRecordsPrefix(target.identity))) as CircleRecord[];
      for (const record of records) {
        if (circle.format >= CHAT_FORMAT && record.keep) continue;
        await view.del(memberRecordKey(target.identity, record.app, record.key));
      }
      return null;
    }
    case 'offer': {
      // Any current member may share; only for themselves.
      if (authorRole === null) return 'not a member';
      const offer = cleanOffer(op.offer);
      if (!offer) return 'bad offer';
      await view.put(offerKey(author!.identity), { ...offer, identity: author!.identity });
      return null;
    }
    case 'withdraw-offer': {
      if (authorRole === null) return 'not a member';
      await view.del(offerKey(author!.identity));
      return null;
    }
    case 'record-set':
    case 'record-del': {
      if (authorRole === null) return 'not a member';
      if (!isRecordName(op.app) || !isRecordName(op.key) || !isRecordScope(op.scope)) return 'bad record';
      if (op.scope === 'circle' && authorRole !== 'admin') return 'only admins write Circle records';
      // Format 1 ignores `keep` and `identity`, as builds before format 2 did.
      const format2 = circle.format >= CHAT_FORMAT;
      if (op.type === 'record-del' && format2 && op.identity !== undefined && op.identity !== author!.identity) {
        return deleteDepartedRecord(view, op, authorRole);
      }
      const identity = op.scope === 'member' ? author!.identity : null;
      const viewKey = identity ? memberRecordKey(identity, op.app, op.key) : circleRecordKey(op.app, op.key);
      if (op.type === 'record-del') {
        await view.del(viewKey);
        return null;
      }
      if (!isRecordValue(op.value)) return 'bad record value';
      const keep = format2 && op.keep !== undefined;
      if (keep && (op.keep !== true || op.scope !== 'member')) return 'bad record';
      await view.put(viewKey, { app: op.app, scope: op.scope, identity, key: op.key, value: op.value, ...(keep ? { keep: true } : {}) });
      return null;
    }
    case 'chat-post':
    case 'chat-edit':
    case 'chat-delete': {
      // Earlier formats skip chat, as builds before format 2 did (ADR 0038 §3).
      if (circle.format < CHAT_FORMAT) return 'unknown operation';
      if (authorRole === null) return 'not a member';
      if (!isRecordName(op.channel)) return 'bad channel';
      if (!fitsChatOp(op)) return 'chat operation too long';
      if (op.type === 'chat-post') return postMessage(view, op, authorMember!);
      if (op.type === 'chat-edit') return editMessage(view, op, author!.identity);
      return deleteMessage(view, op, author!.identity, authorRole);
    }
    default:
      return 'unknown operation';
  }
}

/** An admin deleting a kept record whose owner is no longer a member (ADR 0042 §2). */
async function deleteDepartedRecord(
  view: CircleView,
  op: Extract<CircleOp, { type: 'record-del' }>,
  authorRole: CircleRole
): Promise<string | null> {
  if (authorRole !== 'admin') return 'only admins delete another member’s record';
  if (op.scope !== 'member' || typeof op.identity !== 'string' || !HEX_KEY.test(op.identity)) return 'bad record';
  if (await view.get(memberKey(op.identity))) return 'that member is still in the Circle';
  const key = memberRecordKey(op.identity, op.app, op.key);
  const record = await read<CircleRecord>(view, key);
  if (!record?.keep) return 'no such kept record';
  await view.del(key);
  return null;
}

/** What `apply` would skip a post for without reading the view, or null. */
export function chatPostProblem(op: Extract<CircleOp, { type: 'chat-post' }>): string | null {
  if (!isRecordName(op.channel)) return 'bad channel';
  if (!fitsChatOp(op)) return 'chat operation too long';
  if (!isMessageId(op.id)) return 'bad message id';
  if (!Number.isSafeInteger(op.at) || op.at < 0) return 'bad message time';
  const parts = cleanMessageParts(op);
  if (!parts) return 'bad message';
  if (!isMessageText(op.text, Boolean(parts.call))) return 'bad message text';
  return null;
}

async function postMessage(
  view: CircleView,
  op: Extract<CircleOp, { type: 'chat-post' }>,
  author: CircleMemberRecord
): Promise<string | null> {
  const problem = chatPostProblem(op);
  if (problem) return problem;
  const parts = cleanMessageParts(op)!;
  const index = chatIndexKey(op.channel, author.identity, op.id);
  if (await view.get(index)) return 'message already posted';
  const position = (await read<number>(view, chatCountKey(op.channel))) ?? 0;
  const message: CircleMessageRecord = {
    channel: op.channel,
    position,
    author: author.identity,
    id: op.id,
    name: author.name,
    text: op.text,
    at: op.at,
    edited: false,
    deleted: null,
    ...parts,
  };
  await view.put(chatMessageKey(op.channel, position), message);
  await view.put(index, position);
  await view.put(chatCountKey(op.channel), position + 1);
  return null;
}

async function findMessage(view: CircleView, channel: string, author: string, id: unknown) {
  if (!isMessageId(id)) return null;
  const position = await read<number>(view, chatIndexKey(channel, author, id));
  if (position === null) return null;
  return read<CircleMessageRecord>(view, chatMessageKey(channel, position));
}

/** Only the author edits (ADR 0042 §5). An edit may also add a call's end. */
async function editMessage(
  view: CircleView,
  op: Extract<CircleOp, { type: 'chat-edit' }>,
  identity: string
): Promise<string | null> {
  const message = await findMessage(view, op.channel, identity, op.id);
  if (!message) return 'no such message of theirs';
  if (message.deleted) return 'message deleted';
  let call = message.call;
  if (op.call !== undefined) {
    const next = cleanCall(op.call);
    if (!next || next.id !== message.call?.id) return 'bad message';
    call = next;
  }
  if (!isMessageText(op.text, Boolean(call))) return 'bad message text';
  await view.put(chatMessageKey(op.channel, message.position), {
    ...message,
    text: op.text,
    edited: message.edited || op.text !== message.text,
    ...(call ? { call } : {}),
  });
  return null;
}

/** The author or any admin deletes. The text goes; a stub says who removed it (ADR 0042 §5). */
async function deleteMessage(
  view: CircleView,
  op: Extract<CircleOp, { type: 'chat-delete' }>,
  identity: string,
  role: CircleRole
): Promise<string | null> {
  if (typeof op.author !== 'string' || !HEX_KEY.test(op.author)) return 'bad message';
  if (op.author !== identity && role !== 'admin') return 'only the author or an admin deletes';
  const message = await findMessage(view, op.channel, op.author, op.id);
  if (!message) return 'no such message';
  if (message.deleted) return 'message deleted';
  const { channel, position, author, id, name, at, edited } = message;
  const stub: CircleMessageRecord = { channel, position, author, id, name, text: '', at, edited, deleted: op.author === identity ? 'author' : 'admin' };
  await view.put(chatMessageKey(op.channel, position), stub);
  return null;
}
