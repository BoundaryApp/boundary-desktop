/** Shared folders as main and the renderer see them (ADR 0049). */

/** Managers confirm changes and change roles; editors write; readers have read-only copies. */
export type SharedFolderRole = 'manager' | 'editor' | 'reader';

export interface SharedFolderPerson {
  identity: string;
  name: string;
  role: SharedFolderRole;
}

/** A file on this Mac that the folder doesn't get, and why (ADR 0049 §9). */
export interface UnsharedFile {
  path: string;
  reason: 'never-shared' | 'too-large' | 'link' | 'reader-change';
}

/** What this Mac knows of a folder it has added. */
export interface SharedFolderSummary {
  /** The role people get when they're first added. */
  defaultRole: Exclude<SharedFolderRole, 'manager'> | null;
  people: SharedFolderPerson[];
  writers: Array<{ identity: string; writer: string }>;
  /** This person's role, once the folder's view knows it. */
  role: SharedFolderRole | null;
  writable: boolean;
  /** Files that aren't deleted, and their total size in bytes. */
  files: number;
  bytes: number;
  /** Where this Mac keeps its copy and how it stands; null when it isn't mirrored. */
  mirror: { root: string; unshared: UnsharedFile[]; waiting: number } | null;
  /** Conflict copies not yet resolved, by path (ADR 0049 §7). */
  conflicts: string[];
  /** File changes not yet confirmed by enough managers (§5). */
  unconfirmed: number;
}

/** A folder offered in a Circle. */
export interface SharedFolderListing {
  circle: string;
  key: string;
  name: string;
  /** Who shared it. */
  by: string;
  /** What the sharer said about it when they shared it; null for an offer that didn't say. */
  offered: { role: Exclude<SharedFolderRole, 'manager'>; files: number; bytes: number } | null;
  /** Present when this Mac has added it. */
  local: { root: string; summary: SharedFolderSummary | null } | null;
}

/** Why a folder can't be shared where asked, in words for the share sheet. */
export type SharedFolderProblem =
  | { kind: 'refused'; message: string }
  | { kind: 'git'; message: string }
  /** Inside another sync tool's folder: share a copy instead (ADR 0049 §8). */
  | { kind: 'sync-tool'; tool: string; message: string };

export interface ShareFolderInput {
  /** The Circle's key. */
  key: string;
  name: string;
  /** A folder on this Mac, or null to start an empty one. */
  source: string | null;
  /** Share a copy of `source`, for a folder inside a sync tool. */
  copy?: boolean;
  role: Exclude<SharedFolderRole, 'manager'>;
  /** Other members to make managers from the start, with the names the Circle knows them by. */
  managers?: Array<{ identity: string; name: string }>;
}

/** A shared folder this Mac has, for the project screen: matched to project folders by `root`. */
export interface SharedFolderOnMac {
  key: string;
  circle: string;
  circleName: string;
  name: string;
  root: string;
  /** This person's role, once the folder's view knows it. */
  role: SharedFolderRole | null;
  defaultRole: Exclude<SharedFolderRole, 'manager'> | null;
  /** How many people are in the folder. */
  people: number;
  /** Who manages it, by name ("you" for this user). */
  managers: string[];
  /** When this Mac left the folder's Circle; null while it syncs. */
  ended: number | null;
}

/** One version of a file in a folder's history, newest first. */
export interface SharedFolderChange {
  /** Its place in the folder's history; Restore names a version by it. */
  seq: number;
  path: string;
  version: number;
  deleted: boolean;
  size: number;
  /** The identity that wrote it, and when by their clock. */
  by: string;
  at: number;
  /** Enough managers have seen it that its order is final (ADR 0049 §5). */
  confirmed: boolean;
  /** For a conflict copy: the file it was kept beside. */
  conflictOf: string | null;
  /** Whether this Mac holds its contents; only on a single file's history. */
  here?: boolean;
}

/** The two sides of a conflict, for the Resolve sheet. */
export interface SharedFolderConflict {
  original: SharedFolderChange;
  copy: SharedFolderChange;
  /** Both sides' text, when both are small text files; otherwise null. */
  texts: [string, string] | null;
}

/** What sharing a folder would send (the share sheet's Check step). */
export interface FolderScan {
  files: number;
  bytes: number;
  /** The first files that stay on this Mac, with why. */
  unshared: UnsharedFile[];
  /** How many stay on this Mac in all. */
  unsharedCount: number;
  /** The folder was too large to count to the end; the numbers are a floor. */
  partial: boolean;
}

/** One file in a shared folder's current view. */
export interface SharedFolderFile {
  path: string;
  size: number;
  /** The identity that wrote this version, and when by their clock. */
  by: string;
  at: number;
  /** For a conflict copy: the file it was kept beside (ADR 0049 §7). */
  conflictOf: string | null;
}
