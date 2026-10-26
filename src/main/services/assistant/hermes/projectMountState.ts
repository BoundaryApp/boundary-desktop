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
