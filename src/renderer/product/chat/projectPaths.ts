import { projectRelativePath, uniquePreserveOrder } from '../../../shared/hermesToolPaths';

/** Raw tool paths → the ones inside this project's mount, relative to it, each once. */
export function projectPathsOf(paths: string[], containerPath?: string | null): string[] {
  return uniquePreserveOrder(
    paths
      .map((p) => projectRelativePath(p, containerPath))
      .filter((p): p is string => p != null)
  );
}
