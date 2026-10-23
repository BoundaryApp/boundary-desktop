/**
 * Coding folders (ADR 0028): folders the user lets the coding agent edit and run commands in.
 * A grant uses the host bridge's grant shape (ADR 0027 §7) with coding fields beside it, so
 * the records can move into the bridge's store once it lands on main.
 */

export type CodingGrantOrigin = 'add' | 'project-folder' | 'chat' | 'new-folder';

export interface CodingGrant {
  capability: 'coding';
  /** Absolute host path of the folder. */
  resource: string;
  createdAt: string;
  /** Coding grants never expire; kept for the bridge's shape. */
  expiresAt: null;
  /** The project that granted it; null for a chat outside any project. */
  projectId: string | null;
  origin: CodingGrantOrigin;
  /** True when Boundary created the folder (New folder…). */
  createdByBoundary: boolean;
}

export type CodingGrantRefuseReason =
  | 'not-absolute'
  | 'unsupported-characters'
  | 'root'
  | 'home'
  | 'home-ancestor'
  | 'system'
  | 'boundary-data'
  | 'contains-boundary-data'
  | 'missing';

/** Where a grant stands once the coding agent has restarted. */
export type CodingGrantState = 'ready' | 'not-visible';

export interface CodingGrantRow extends CodingGrant {
  state: CodingGrantState;
  /** Hermes's own edits start at its next restart (ADR 0028 §4). */
  hermesPending: boolean;
}

export interface CodingAgentBusy {
  busy: boolean;
  /** OpenCode session titles that are working, when OpenCode reports them. */
  sessions: string[];
}

export interface CodingFoldersResult {
  success: boolean;
  /** False in local-stack mode: the developer's own stack manages coding roots (ADR 0028 §13). */
  managed: boolean;
  grants: CodingGrantRow[];
  /** Set when a grant was refused because a coding task is running and the caller didn't wait. */
  busy?: CodingAgentBusy;
  /** The command to run instead, in local-stack mode. */
  command?: string;
  error?: string;
}

export interface CodingGrantPayload {
  projectId: string | null;
  hostPath: string;
  origin: Exclude<CodingGrantOrigin, 'project-folder' | 'new-folder'>;
  /** Restart even when a coding task is running (the user chose "Stop task and add"). */
  stopRunningTask?: boolean;
}

export interface CodingProjectFolderPayload {
  projectId: string;
  enabled: boolean;
  stopRunningTask?: boolean;
}

export interface CodingRevokePayload {
  hostPath: string;
  stopRunningTask?: boolean;
}

export interface CodingCreateFolderPayload {
  projectId: string | null;
  parent: string;
  name: string;
  initGit: boolean;
  /** False creates the folder for read-only reference, without a coding grant. */
  grant?: boolean;
  stopRunningTask?: boolean;
}

/** Live validation for the New folder… form. */
export interface CodingNewFolderCheck {
  success: boolean;
  hostPath?: string;
  exists?: boolean;
  isDirectory?: boolean;
  isGit?: boolean;
  /** Top-level entries in an existing folder, capped at 10,000. */
  entries?: number;
  error?: string;
}

export interface CodingNewFolderDefaults {
  defaultParent: string;
  /** False when host git is missing; Start a git repo is then off and says why. */
  gitAvailable: boolean;
  managed: boolean;
}

/** What the add sheet needs to know about a folder before choosing access. */
export interface CodingFolderInspect {
  success: boolean;
  canceled?: boolean;
  hostPath?: string;
  name?: string;
  isGit?: boolean;
  /** Why it can't be a coding folder; it may still be added as read-only reference. */
  refuseMessage?: string | null;
  managed?: boolean;
  error?: string;
}

export interface CodingCreateFolderResult extends CodingFoldersResult {
  hostPath?: string;
  /** The folder already exists; the UI offers "Use existing folder". */
  exists?: boolean;
}

/** Remove a coding grant from Settings (ADR 0028 §10). Files on disk are never touched. */
export interface CodingRemoveFolderPayload {
  hostPath: string;
  /** `reference` keeps the folder as a read-only source in its project (the default). */
  keep: 'reference' | 'none';
  stopRunningTask?: boolean;
}

/** What the delete review shows before the user accepts (ADR 0028 §11). */
export interface CodingDeleteInspect {
  success: boolean;
  error?: string;
  hostPath?: string;
  name?: string;
  projectId?: string | null;
  origin?: CodingGrantOrigin;
  createdByBoundary?: boolean;
  createdAt?: string;
  files?: number;
  bytes?: number;
  nodeModulesBytes?: number;
  /** ISO time of the newest change found. */
  lastChanged?: string | null;
  /** The walk stopped at its cap, so counts are lower bounds. */
  truncated?: boolean;
  isGit?: boolean;
  hasRemote?: boolean;
  /** Commits on local branches that no remote has. */
  unpushed?: number;
  /** The only commit is Boundary's empty "Start" commit. */
  onlyStartCommit?: boolean;
  dirtyCount?: number;
  /** Up to five paths with uncommitted changes. */
  dirtyFiles?: string[];
  /** The user must type the folder name to confirm. */
  requiresTypedName?: boolean;
  busy?: CodingAgentBusy;
}

export interface CodingDeleteFolderPayload {
  hostPath: string;
  /** The folder's name as typed, when the review asked for it. */
  confirmName?: string;
}

export interface CodingDeleteFolderResult extends CodingFoldersResult {
  trashed?: boolean;
}

/**
 * A coding task asked for a folder the coding agent can't reach (ADR 0028 §9). Boundary shows
 * a card instead of the skill's `make` hint; the user decides.
 */
export interface CodingAccessRequestEvent {
  id: string;
  sessionId: string;
  requestId: string;
  hostPath: string;
  name: string;
  /** False when the folder doesn't exist yet: the card offers to create it. */
  exists: boolean;
  isGit: boolean;
  projectId: string | null;
  /**
   * Set when the folder is a project's own folder: the card turns on that project's coding
   * switch instead of adding a separate grant (ADR 0028 §12).
   */
  projectFolderId: string | null;
  projectFolderName: string | null;
  /** Why it can't be granted; the card then only explains. */
  refuseMessage: string | null;
}
