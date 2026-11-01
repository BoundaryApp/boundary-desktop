export type UpdateChannel = 'stable' | 'beta';

/** `available` waits for the user's Download; nothing downloads before that. */
export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'ready';

/**
 * Why this build can't update itself. `no-feed` covers dev builds and forks; `no-key` is a build
 * whose feed needs a personal key that hasn't been entered.
 */
export type UpdateBlock = 'none' | 'no-feed' | 'not-in-applications' | 'no-key';

export interface RunningWorkItem {
  id: string;
  kind: 'chat' | 'task' | 'coding';
  title: string;
  detail: string;
}

export interface UpdateWaitItem extends RunningWorkItem {
  finished: boolean;
}

export interface UpdateSnapshot {
  currentVersion: string;
  channel: UpdateChannel;
  checksEnabled: boolean;
  blocked: UpdateBlock;
  phase: UpdatePhase;
  /** The version on offer; null in `idle`. */
  version: string | null;
  /** Plain-language lines from the feed. */
  summary: string[];
  /** Download size in bytes, when the feed gives one. */
  size: number | null;
  /**
   * Whole percent of the zip received during `downloading`; null when the total isn't known or
   * nothing is downloading. 100 means every byte is in and Squirrel is checking the update.
   */
  downloadPercent: number | null;
  /** This update moves the stack, so the first start after it takes minutes. */
  stackChanges: boolean;
  checking: boolean;
  lastCheckedAt: string | null;
  error: 'check' | 'download' | 'key' | null;
  /** This build's feed needs a personal key, so a check identifies the person. */
  keyRequired: boolean;
  /** The update card opens by itself: this version and stage haven't been closed. */
  showCard: boolean;
  /** The work a waiting restart is watching; empty when no restart is waiting. */
  waiting: UpdateWaitItem[];
  /** Seconds left before a waited-for restart goes ahead; null outside the last call. */
  restartIn: number | null;
  /** Boundary is stopping to install, so the quit screen says it reopens. */
  restarting: boolean;
  /** The update that brought this version, for What's new. */
  updated: { version: string; summary: string[] } | null;
  /** The card saying the update finished hasn't been closed. */
  showUpdated: boolean;
}

export type UpdateRestartResult =
  | { status: 'restarting' }
  | { status: 'not-ready' }
  | { status: 'work-running'; items: RunningWorkItem[] };
