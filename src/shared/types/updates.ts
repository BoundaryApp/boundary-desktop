export type UpdateChannel = 'stable' | 'beta';

/** `available` waits for the user's Download; nothing downloads before that. */
export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'ready';

/** Why this build can't update itself. `no-feed` covers dev builds and forks. */
export type UpdateBlock = 'none' | 'no-feed' | 'not-in-applications';

export interface UpdateSnapshot {
  currentVersion: string;
  channel: UpdateChannel;
  checksEnabled: boolean;
  blocked: UpdateBlock;
  phase: UpdatePhase;
  /** The version on offer; null in `idle`. */
  version: string | null;
  /** Plain-language line from the feed. */
  summary: string;
  checking: boolean;
  lastCheckedAt: string | null;
  error: 'check' | 'download' | null;
  /** The workbench notice for this version and phase hasn't been closed. */
  showNotice: boolean;
  /** The dot on Settings: an update is on offer and the Updates tab hasn't been opened for it. */
  showDot: boolean;
  /** Items the restart is waiting for; 0 when no restart is waiting. */
  waitingFor: number;
}

export interface RunningWorkItem {
  id: string;
  title: string;
  detail: string;
}

export type UpdateRestartResult =
  | { status: 'restarting' }
  | { status: 'not-ready' }
  | { status: 'work-running'; items: RunningWorkItem[] };
