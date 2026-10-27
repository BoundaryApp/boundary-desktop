import path from 'node:path';

/**
 * Host folders the running Hermes container was created with, or null when Boundary doesn't
 * know (no `up` in this process yet, or the stack was already running). Lets the first-run
 * Folders step skip a recreate when the first `compose up` already mounted its picks.
 */
let mounted: Set<string> | null = null;

export function recordMountedProjectFolders(hostPaths: readonly string[]): void {
  mounted = new Set(hostPaths.map((hostPath) => path.resolve(hostPath)));
}

export function areProjectFoldersMounted(hostPaths: readonly string[]): boolean {
  if (!mounted) return false;
  const known = mounted;
  return hostPaths.every((hostPath) => known.has(path.resolve(hostPath)));
}

export function resetMountedProjectFoldersForTests(): void {
  mounted = null;
}

export interface FolderRemountOutcome {
  success: boolean;
  error?: string;
}

/**
 * Every folder action that changes what the containers mount (project folders, source
 * folders, coding grants) runs its remount here, one at a time, so two `compose up
 * --force-recreate` runs never overlap on the same services. Each job writes the overlay
 * from the stores when its turn starts, so it mounts what is current then.
 */
let remountTail: Promise<unknown> = Promise.resolve();

export function enqueueFolderRemount(
  job: () => Promise<FolderRemountOutcome>
): Promise<FolderRemountOutcome> {
  const next = remountTail
    .catch((): undefined => undefined)
    .then(job)
    .catch(
      (error: unknown): FolderRemountOutcome => ({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    );
  remountTail = next;
  return next;
}

/**
 * Take a turn in the remount queue and keep it until the returned release is called. The
 * stack start holds one from its overlay write until `up` is healthy, so no remount
 * recreates containers that `up` is creating.
 */
export function holdFolderRemounts(): Promise<() => void> {
  return new Promise((turnStarted) => {
    void enqueueFolderRemount(
      () =>
        new Promise<FolderRemountOutcome>((done) => {
          turnStarted(() => done({ success: true }));
        })
    );
  });
}

/** Test-only: drop any queued remount. */
export function resetFolderRemountQueueForTests(): void {
  remountTail = Promise.resolve();
}
