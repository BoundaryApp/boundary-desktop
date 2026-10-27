import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { containerPathForSlug } from './hermesProjectsOverlay';

/** Gateway project row from `projects.list` (subset we care about). */
export interface GatewayProjectInfo {
  id: string;
  slug: string;
  name: string;
  primaryPath?: string | null;
  archived?: boolean;
}

export interface HermesProjectsListPayload {
  projects: GatewayProjectInfo[];
  activeId: string | null;
}

const LIBRARY_ROOT = '/opt/projects';

/** True when path is an immediate child of /opt/projects. */
export function isLibraryContainerPath(containerPath: string): boolean {
  const normalized = path.posix.normalize(containerPath.replace(/\\/g, '/'));
  if (!normalized.startsWith(`${LIBRARY_ROOT}/`)) return false;
  const rest = normalized.slice(LIBRARY_ROOT.length + 1);
  return Boolean(rest) && !rest.includes('/') && !rest.startsWith('.');
}

export function slugFromLibraryContainerPath(containerPath: string): string | null {
  if (!isLibraryContainerPath(containerPath)) return null;
  return path.posix.basename(containerPath.replace(/\\/g, '/'));
}

export function hostPathForLibrarySlug(dataRoot: string, slug: string): string {
  return path.join(dataRoot, 'projects', slug);
}

function findStoredMatch(
  stored: readonly HermesProjectRecord[],
  gateway: GatewayProjectInfo
): HermesProjectRecord | undefined {
  const byHermesId = stored.find((p) => p.hermesProjectId && p.hermesProjectId === gateway.id);
  if (byHermesId) return byHermesId;

  const containerPath =
    gateway.primaryPath && isLibraryContainerPath(gateway.primaryPath)
      ? path.posix.normalize(gateway.primaryPath.replace(/\\/g, '/'))
      : containerPathForSlug(gateway.slug);

  return (
    stored.find((p) => p.containerPath === containerPath) ??
    stored.find((p) => p.slug === gateway.slug)
  );
}

/**
 * Merge gateway `projects.list` (FS library source of truth) into Boundary store records.
 * Preserves Boundary UUIDs when rematching by hermesProjectId / containerPath / slug.
 */
function mergeGatewayProjectsIntoStore(options: {
  stored: readonly HermesProjectRecord[];
  gateway: HermesProjectsListPayload;
  dataRoot: string;
  now?: string;
}): HermesProjectRecord[] {
  const now = options.now ?? new Date().toISOString();
  const { stored, gateway, dataRoot } = options;

  const matchedStoredIds = new Set<string>();
  const merged: HermesProjectRecord[] = [];

  for (const gp of gateway.projects) {
    if (gp.archived) continue;

    const primary =
      gp.primaryPath && isLibraryContainerPath(gp.primaryPath)
        ? path.posix.normalize(gp.primaryPath.replace(/\\/g, '/'))
        : null;
    const slug = primary ? (slugFromLibraryContainerPath(primary) ?? gp.slug) : gp.slug;
    const containerPath = primary ?? containerPathForSlug(slug);
    const existing = findStoredMatch(stored, { ...gp, slug, primaryPath: containerPath });

    if (existing) {
      matchedStoredIds.add(existing.id);
      const libraryHostRoot = path.join(dataRoot, 'projects');
      const relToLibrary = path.relative(libraryHostRoot, existing.hostPath);
      const isUnderLibrary =
        relToLibrary === '' ||
        (!relToLibrary.startsWith('..') && !path.isAbsolute(relToLibrary));
      const isHostOutsideLibrary = existing.kind === 'host-folder' && !isUnderLibrary;
      const name = gp.name || existing.name;
      const hostPath = isHostOutsideLibrary
        ? existing.hostPath
        : hostPathForLibrarySlug(dataRoot, slug);
      // updatedAt orders the picker by last use, so only a change the user sees moves it.
      const seenChange =
        name !== existing.name ||
        slug !== existing.slug ||
        containerPath !== existing.containerPath ||
        hostPath !== existing.hostPath;
      merged.push({
        ...existing,
        name,
        slug,
        containerPath,
        hermesProjectId: gp.id,
        hostPath,
        kind: isHostOutsideLibrary ? 'host-folder' : 'empty',
        updatedAt: seenChange ? now : existing.updatedAt,
      });
    } else if (isLibraryContainerPath(containerPath)) {
      merged.push({
        id: randomUUID(),
        name: gp.name || slug,
        hostPath: hostPathForLibrarySlug(dataRoot, slug),
        containerPath,
        slug,
        hermesProjectId: gp.id,
        kind: 'empty',
        inference: { mode: 'inherit' },
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Keep unmatched host-folder rows (out-of-tree) when gateway omitted them or
  // when we need offline resilience for mounts Boundary still owns.
  for (const row of stored) {
    if (matchedStoredIds.has(row.id)) continue;
    if (row.kind === 'host-folder') {
      merged.push(row);
    }
    // Drop stale library/empty rows not present on gateway.
  }

  return merged;
}

/**
 * Resolve active Boundary project id after a merge.
 * Prefer previous store active when still present; else map gateway active_id.
 */
export function resolveActiveProjectId(options: {
  previousActiveId: string | null;
  projects: readonly HermesProjectRecord[];
  gatewayActiveId: string | null;
}): string | null {
  const { previousActiveId, projects, gatewayActiveId } = options;
  // Explicit none persists across gateway sync — do not auto-pick projects[0].
  if (previousActiveId === null) {
    return null;
  }
  if (projects.some((p) => p.id === previousActiveId)) {
    return previousActiveId;
  }
  if (gatewayActiveId) {
    const byHermes = projects.find((p) => p.hermesProjectId === gatewayActiveId);
    if (byHermes) return byHermes.id;
  }
  return null;
}

/** Full merge used by listHermesProjects when gateway responds. */
export function syncProjectsFromGateway(options: {
  stored: readonly HermesProjectRecord[];
  previousActiveId: string | null;
  gateway: HermesProjectsListPayload;
  dataRoot: string;
  now?: string;
}): {
  projects: HermesProjectRecord[];
  activeId: string | null;
} {
  const projects = mergeGatewayProjectsIntoStore(options);
  const activeId = resolveActiveProjectId({
    previousActiveId: options.previousActiveId,
    projects,
    gatewayActiveId: options.gateway.activeId,
  });
  return { projects, activeId };
}
