import { CIRCLE_KEY, ME, circleMember, circleSnapshot } from '../../../__tests__/circleFixtures';
import type { SharedFolderChange, SharedFolderListing, SharedFolderSummary } from '../../../../shared/types/sharedFolders';

/** Sam's identity key: the Studio admin and the folder's other manager, offline by default. */
export const SAM = 'bb'.repeat(32);
/** The Studio Circle's key. */
export const STUDIO = CIRCLE_KEY;
/** The Cover art folder's key. */
export const COVER = 'dd'.repeat(32);

/** Studio as Jordan sees it: Jordan a member, Sam the only admin and offline. */
export const circle = circleSnapshot({
  key: STUDIO,
  name: 'Studio',
  members: [circleMember({ identity: ME, name: 'Jordan', isMe: true }), circleMember({ identity: SAM, name: 'Sam', role: 'admin', online: false })],
});

/** What main reports of Cover art once added on this Mac: Jordan an editor, Sam its manager. */
const summary = (extra: Partial<SharedFolderSummary> = {}): SharedFolderSummary => ({
  defaultRole: 'editor',
  people: [
    { identity: SAM, name: 'Sam', role: 'manager' },
    { identity: ME, name: 'Jordan', role: 'editor' },
  ],
  writers: [],
  role: 'editor',
  writable: true,
  files: 2,
  bytes: 2048,
  mirror: { root: '/Users/jordan/Circles/Studio/Cover art', unshared: [{ path: '.env', reason: 'never-shared' }], waiting: 0 },
  conflicts: [],
  unconfirmed: 0,
  ...extra,
});

/** Cover art as Sam offers it, not yet added on this Mac. */
export const offered: SharedFolderListing = {
  circle: STUDIO,
  key: COVER,
  name: 'Cover art',
  by: SAM,
  offered: { role: 'editor', files: 2, bytes: 2048 },
  local: null,
};
/** Cover art added on this Mac, with `extra` in its summary. */
export const added = (extra: Partial<SharedFolderSummary> = {}): SharedFolderListing => ({
  ...offered,
  local: { root: '/Users/jordan/Circles/Studio/Cover art', summary: summary(extra) },
});

/** One change Sam made to brief.md and the managers confirmed. */
export const change = (extra: Partial<SharedFolderChange> = {}): SharedFolderChange => ({
  seq: 1,
  path: 'brief.md',
  version: 1,
  deleted: false,
  size: 10,
  by: SAM,
  at: Date.now(),
  confirmed: true,
  conflictOf: null,
  ...extra,
});
