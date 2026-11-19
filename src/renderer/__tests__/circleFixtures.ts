import type {
  CircleMemberView,
  CircleOfferView,
  CircleSharing,
  CircleSnapshot,
  CirclesState,
} from '../../shared/types/circles';

/** This user's identity key in the default state. */
export const ME = 'a'.repeat(64);
/** Bo's identity key: the other member, and the default provider of an offer. */
export const BO = 'b'.repeat(64);
/** The default Circle's key. */
export const CIRCLE_KEY = 'c'.repeat(64);

/** An online member other than this user, with the identity and name given. */
export function circleMember(overrides: Partial<CircleMemberView> & Pick<CircleMemberView, 'identity' | 'name'>): CircleMemberView {
  return { role: 'member', isMe: false, online: true, ...overrides };
}

/** Bo's offer, available and online, with no models unless given. */
export function circleOffer(overrides: Partial<CircleOfferView> = {}): CircleOfferView {
  return { identity: BO, name: 'Bo', isMine: false, models: [], available: true, away: false, online: true, ...overrides };
}

/** One Circle as main sends it: Garden club, where this user is a member, caught up and writable. */
export function circleSnapshot(overrides: Partial<CircleSnapshot> = {}): CircleSnapshot {
  return {
    key: CIRCLE_KEY,
    name: 'Garden club',
    myRole: 'member',
    members: [],
    invites: [],
    offers: [],
    needsUpdate: false,
    writable: true,
    format: 2,
    ...overrides,
  };
}

/** What a user who shares nothing has saved. */
export function circleSharing(overrides: Partial<CircleSharing> = {}): CircleSharing {
  return { models: [], circles: [], paused: false, away: false, ...overrides };
}

interface RunningOptions extends Partial<CirclesState> {
  /** The snapshot's Circles; one default Circle when left out. Ignored when `snapshot` is given. */
  circles?: CircleSnapshot[];
  /** This user's identity key in the snapshot. Ignored when `snapshot` is given. */
  identity?: string;
}

/**
 * Circles running for Ada, sharing nothing and trusting no provider. Any `CirclesState` field
 * given replaces the default whole.
 */
export function runningCircles({ circles = [circleSnapshot()], identity = ME, ...overrides }: RunningOptions = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    snapshot: { identity, circles },
    providers: {},
    sharing: circleSharing(),
    ...overrides,
  };
}
