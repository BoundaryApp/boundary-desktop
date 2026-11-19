/**
 * What sharing a folder would send, for the share sheet's Check step (shared folders spec, Flows):
 * how many files and bytes each member downloads, and which files stay on this Mac and why
 * (ADR 0049 §9). Reads names and sizes only, never contents, and follows no links.
 */

import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FolderScan, UnsharedFile } from '../../../shared/types/sharedFolders';
import { cleanPath, isNeverShared, MAX_FILE_BYTES } from './folderOps';

/** Stop counting after this many entries, so a huge folder doesn't stall the sheet. */
const ENTRY_LIMIT = 50_000;
/** Unshared files listed by name; the rest are only counted. */
const UNSHARED_LIMIT = 50;

export async function scanFolder(root: string, limits = { entries: ENTRY_LIMIT, unshared: UNSHARED_LIMIT }): Promise<FolderScan> {
  const scan: FolderScan = { files: 0, bytes: 0, unshared: [], unsharedCount: 0, partial: false };
  let seen = 0;
  const skip = (file: UnsharedFile) => {
    scan.unsharedCount += 1;
    if (scan.unshared.length < limits.unshared) scan.unshared.push(file);
  };
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > limits.entries) {
        scan.partial = true;
        return;
      }
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skip({ path: rel, reason: 'link' });
      } else if (entry.isDirectory()) {
        if (isNeverShared(rel)) skip({ path: `${rel}/`, reason: 'never-shared' });
        else await walk(rel);
      } else if (entry.isFile()) {
        if (!cleanPath(rel) || isNeverShared(rel)) {
          skip({ path: rel, reason: 'never-shared' });
          continue;
        }
        const size = await lstat(path.join(root, rel)).then((stats): number | null => stats.size, (): null => null);
        if (size === null) continue;
        if (size > MAX_FILE_BYTES) {
          skip({ path: rel, reason: 'too-large' });
        } else {
          scan.files += 1;
          scan.bytes += size;
        }
      }
      if (scan.partial) return;
    }
  };
  await walk('');
  return scan;
}
