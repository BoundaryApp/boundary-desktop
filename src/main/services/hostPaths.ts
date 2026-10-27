import fs from 'node:fs';
import path from 'node:path';

/** Whether two host paths resolve to the same absolute path (no symlinks followed). */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** Whether `child` is `parent` or inside it, after resolving both. */
export function isPathUnder(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const prefix = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : `${resolvedParent}${path.sep}`;
  return resolvedChild.startsWith(prefix);
}

/** The path with symlinks resolved, or `path.resolve(p)` when it doesn't exist. */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
