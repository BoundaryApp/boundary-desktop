/**
 * What a Circle's Autobase holds and how its operations apply (ADR 0032 §3–§5). This runs inside
 * Autobase's `apply`, on every peer, in the order the indexers settle on, so it must be
 * deterministic: no clock, no randomness, nothing outside the view. An operation its author may
 * not perform is skipped, never thrown on, so one bad entry can't stop the Circle.
 *
 * Kept free of native modules so it can be tested on its own; the signature check is passed in.
 */

import type { SharedModelOffer } from '../../../shared/types/circles';

export type CircleRole = 'admin' | 'member';

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

export type CircleOp =
  | { type: 'create'; name: string; member: CircleMemberIntro }
  | { type: 'add-member'; member: CircleMemberIntro; invite: string }
  | { type: 'set-role'; identity: string; role: CircleRole }
  | { type: 'remove-member'; identity: string }
  | { type: 'invite'; invite: Pick<CircleInviteRecord, 'id' | 'publicKey' | 'expires'> }
  | { type: 'revoke-invite'; id: string }
  | { type: 'offer'; offer: CircleOffer }
  | { type: 'withdraw-offer' };

/** View keys. */
export const CIRCLE_KEY = 'circle';
export const memberKey = (identity: string): string => `members/${identity}`;
const writerKey = (writer: string): string => `writers/${writer}`;
export const inviteKey = (id: string): string => `invites/${id}`;
export const offerKey = (identity: string): string => `offers/${identity}`;
export const MEMBERS_PREFIX = 'members/';
export const INVITES_PREFIX = 'invites/';
export const OFFERS_PREFIX = 'offers/';

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
}

export interface CircleNode {
  value: unknown;
  from: { key: Buffer };
}

export interface CircleApplyDeps {
  /** ed25519 verify over raw bytes. */
  verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean;
  /** Called with each skipped operation and why, for the debug log. */
  onSkip?(reason: string, op: unknown): void;
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const MAX_NAME = 80;
const MAX_OFFERED_MODELS = 32;
const MAX_MODEL_ID = 200;
const MAX_CONTEXT = 100_000_000;

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

function introOnly(intro: CircleMemberIntro): CircleMemberIntro {
  const { identity, name, writer, device, signature } = intro;
  return { identity, name: name.trim(), writer, device, signature };
}

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
  const circle = await read<{ name: string }>(view, CIRCLE_KEY);

  if (op.type === 'create') {
    if (circle) return 'the Circle already exists';
    if (typeof op.name !== 'string' || !op.name.trim() || op.name.length > MAX_NAME) return 'bad name';
    // The creator's device is the bootstrap writer and already an indexer.
    if (!introIsValid(op.member, deps) || op.member.writer !== from) return 'bad creator intro';
    await view.put(CIRCLE_KEY, { name: op.name.trim() });
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
      await view.del(memberKey(target.identity));
      await view.del(writerKey(target.writer));
      // A member who leaves stops sharing too (ADR 0033 §10: their entries go stale).
      await view.del(offerKey(target.identity));
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
    default:
      return 'unknown operation';
  }
}
