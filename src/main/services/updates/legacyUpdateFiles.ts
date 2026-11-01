import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Builds through 0.0.1-rc.13 downloaded into this folder, and left it if they quit mid-download. */
const LEGACY_PREFIX = 'boundary-update-';
/** A younger folder may be an older instance's download in progress. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Removes those folders and returns how many went. One that can't be removed is left for later. */
export async function removeLegacyUpdateFiles(dir: string, now: number): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(LEGACY_PREFIX)) continue;
    const path = join(dir, entry.name);
    try {
      const { mtimeMs } = await stat(path);
      if (now - mtimeMs < MIN_AGE_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}
