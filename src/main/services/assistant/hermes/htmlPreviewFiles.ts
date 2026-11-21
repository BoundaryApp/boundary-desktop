import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  HermesHtmlPreviewPayload,
  HermesHtmlPreviewResult,
} from '../../../../shared/types/hermesChat';
import {
  PREVIEW_MAX_BYTES,
  PROJECTS_CONTAINER_ROOT,
  isPreviewablePath,
} from '../../../../shared/htmlPreview';
import { isPathUnder } from '../../hostPaths';
import { resolveAssistantUserContentRoot } from '../assistantPaths';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
import { listStoredHermesProjects } from './hermesProjectStore';
import { stackCapabilityRefusal } from '../../stackHost/capabilities';

/**
 * Reads an HTML page an agent wrote, for the preview sheet (message-actions spec,
 * Phase 5). The renderer sends a container path; this is the only place it becomes a
 * Mac path, and only files whose real path stays inside an allowed folder are read.
 */

export interface PreviewRoots {
  /** `ASSISTANT_DATA_ROOT/projects` on the Mac, mounted at `/opt/projects` in the containers. */
  projectsRoot: string;
  /** Host-folder projects, each mounted at its own `containerPath`. */
  hostFolders: { containerPath: string; hostPath: string }[];
}

const TOO_LARGE = 'That page is larger than 2 MB.';
const OUTSIDE = 'That file is outside the folders Boundary can open.';

function defaultRoots(): PreviewRoots {
  return {
    projectsRoot: path.join(
      resolveAssistantUserContentRoot(resolveActiveAssistantRoot()),
      'projects',
    ),
    hostFolders: listStoredHermesProjects().flatMap((project) =>
      project.kind === 'host-folder' && project.containerPath
        ? [{ containerPath: project.containerPath, hostPath: project.hostPath }]
        : [],
    ),
  };
}

/**
 * Mac path for a container path: a host-folder pair that contains it first (the same rule
 * as `hostPathForAlias`), else `/opt/projects/<rest>` under the projects root. Null for
 * anything else and for any path with a `..` segment. Symlinks are checked by the caller.
 */
export function previewHostPath(containerPath: string, roots: PreviewRoots): string | null {
  if (!path.posix.isAbsolute(containerPath)) return null;
  if (containerPath.split('/').includes('..')) return null;
  const clean = path.posix.normalize(containerPath);
  for (const pair of roots.hostFolders) {
    const alias = path.posix.normalize(pair.containerPath);
    if (clean === alias) return path.resolve(pair.hostPath);
    if (clean.startsWith(`${alias.replace(/\/+$/, '')}/`)) {
      return path.join(path.resolve(pair.hostPath), path.posix.relative(alias, clean));
    }
  }
  const prefix = `${PROJECTS_CONTAINER_ROOT}/`;
  if (!clean.startsWith(prefix)) return null;
  return path.join(
    path.resolve(roots.projectsRoot),
    path.posix.relative(PROJECTS_CONTAINER_ROOT, clean),
  );
}

/** Real paths of the allowed folders; one that is missing on disk is left out. */
async function realRoots(roots: PreviewRoots): Promise<string[]> {
  const real: string[] = [];
  for (const root of [roots.projectsRoot, ...roots.hostFolders.map((pair) => pair.hostPath)]) {
    try {
      real.push(await fs.realpath(root));
    } catch {
      // Not on disk (yet): nothing can be inside it.
    }
  }
  return real;
}

export async function readHtmlPreview(
  payload: HermesHtmlPreviewPayload,
  roots: PreviewRoots = defaultRoots(),
): Promise<HermesHtmlPreviewResult> {
  const hostFoldersRefusal = stackCapabilityRefusal('hostFolders');
  if (hostFoldersRefusal) return { success: false, error: hostFoldersRefusal };
  const containerPath = payload.containerPath;
  if (!isPreviewablePath(containerPath)) {
    return { success: false, error: 'Only .html pages can be previewed.' };
  }
  const hostPath = previewHostPath(containerPath, roots);
  if (!hostPath) return { success: false, error: OUTSIDE };
  let real: string;
  try {
    real = await fs.realpath(hostPath);
  } catch {
    return { success: false, error: 'That file no longer exists.' };
  }
  if (!(await realRoots(roots)).some((root) => isPathUnder(real, root))) {
    return { success: false, error: OUTSIDE };
  }
  // Everything after the check goes through one handle, so a directory swapped for a
  // symlink, a file that grows, or a FIFO put in its place cannot change what is read.
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) return { success: false, error: 'That file no longer exists.' };
    if (stat.size > PREVIEW_MAX_BYTES) return { success: false, error: TOO_LARGE };
    // The path must still lead to the opened file, inside an allowed folder.
    const again = await fs.realpath(real);
    const now = await fs.stat(again);
    if (
      now.dev !== stat.dev ||
      now.ino !== stat.ino ||
      !(await realRoots(roots)).some((root) => isPathUnder(again, root))
    ) {
      return { success: false, error: OUTSIDE };
    }
    const buffer = Buffer.alloc(PREVIEW_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > PREVIEW_MAX_BYTES) return { success: false, error: TOO_LARGE };
    return {
      success: true,
      html: buffer.toString('utf8', 0, length),
      name: path.posix.basename(containerPath),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { success: false, error: OUTSIDE };
    if (code === 'ENOENT') return { success: false, error: 'That file no longer exists.' };
    return { success: false, error: 'That file could not be read.' };
  } finally {
    await handle?.close().catch((): void => undefined);
  }
}
