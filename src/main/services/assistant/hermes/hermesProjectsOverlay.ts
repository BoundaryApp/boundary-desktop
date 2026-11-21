import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { BOUNDARY_HERMES_TERMINAL_BACKEND } from '../../../../shared/assistantStackConstants';
import { slugify, uniqueSlug } from '../../../../shared/utils/slug';
import { resolveAssistantStackHome } from '../assistantPaths';
import { getStackFiles } from '../../stackHost/activeStack';
import type { StackFiles } from '../../stackHost/types';
import { collectContextExtraRoots } from './hermesContextRoots';
import {
  currentCodingMounts,
  currentStackDataMasks,
  ensureCodingShadowSource,
  ensureStackDataMaskSource,
  type CodingMounts,
  type StackDataMasks,
} from '../coding/codingMounts';
import { stackDataMaskTargets } from '../coding/codingGrantRules';
import { hasStackCapability } from '../../stackHost/capabilities';

const HERMES_PROJECTS_OVERLAY_FILENAME = 'docker-compose.projects.yml';

export function resolveHermesProjectsOverlayPath(): string {
  return path.join(resolveAssistantStackHome(), HERMES_PROJECTS_OVERLAY_FILENAME);
}

export function slugifyProjectName(name: string): string {
  return slugify(name, { max: 48, fallback: 'project' });
}

export function containerPathForSlug(slug: string): string {
  return `/opt/projects/${slug}`;
}

export function displayHostPath(hostPath: string): string {
  const home = os.homedir();
  if (hostPath === home) return '~';
  if (hostPath.startsWith(`${home}/`) || hostPath.startsWith(`${home}\\`)) {
    return `~${hostPath.slice(home.length)}`;
  }
  return hostPath;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function volumeLine(hostToContainer: string): string {
  return `      - ${hostToContainer}`;
}

/** Context roots as identity binds: resolved, deduplicated, never `/` or home. */
function extraBindPaths(extraRoots: readonly string[]): string[] {
  const home = os.homedir();
  const seen = new Set<string>();
  for (const raw of extraRoots) {
    const resolved = path.resolve(raw);
    if (resolved === path.resolve('/') || resolved === home) continue;
    seen.add(resolved);
  }
  return [...seen];
}

/**
 * One empty read-only folder over each stack checkout's `data/` that a service's binds show
 * (CR 0040 stack reply). Each bind is `[hostPath, containerPath]`; a target two binds share is
 * listed once, since compose refuses a duplicate mount point.
 */
function stackDataMaskLines(
  binds: ReadonlyArray<readonly [string, string]>,
  masks: StackDataMasks | null
): string[] {
  if (!masks || masks.dataDirs.length === 0) return [];
  const targets = new Set(
    binds.flatMap(([host, container]) => stackDataMaskTargets(host, container, masks.dataDirs))
  );
  return [...targets].map((target) => yamlQuote(`${masks.source}:${target}:ro`));
}

/**
 * Build the compose overlay that adds one bind per host-folder project plus identity
 * :ro context roots. Compose merges `volumes` by container path, so this only lists
 * additions; the base and Boundary overlays keep every other mount. Empty projects live
 * under the existing data/projects bind.
 *
 * Writes and shell commands run in hermes-worker (the ssh backend), so it gets the project
 * binds read-write and the context roots. hermes keeps read-only copies under its read-only
 * /opt/projects for projects.list / projects.tree. hermes-webui gets the project binds.
 *
 * Coding grants (ADR 0028 §4) add identity read-write binds on `opencode` and the terminal
 * service, each with an empty read-only file over its top-level `.env` files (§6). Every
 * service that shows a stack checkout through any of these binds gets an empty read-only
 * folder over that checkout's `data/` (§6).
 */
export function buildHermesProjectsOverlayYaml(
  projects: readonly HermesProjectRecord[],
  extraRoots: readonly string[] = [],
  coding: CodingMounts | null = null,
  masks: StackDataMasks | null = null
): string {
  const hostFolders = projects.filter((p) => p.kind === 'host-folder');
  // Quote the whole bind: `"a b":/x` is not valid YAML, `"a b:/x"` is.
  const projectBinds = hostFolders.map((p) => yamlQuote(`${p.hostPath}:${p.containerPath}`));
  const readOnlyProjectBinds = hostFolders.map((p) =>
    yamlQuote(`${p.hostPath}:${p.containerPath}:ro`)
  );
  const extraPaths = extraBindPaths(extraRoots);
  const extraBinds = extraPaths.map((resolved) => yamlQuote(`${resolved}:${resolved}:ro`));
  const codingRoots = coding?.roots ?? [];
  const codingBinds = [
    ...codingRoots.map((root) => yamlQuote(`${root}:${root}`)),
    ...(coding?.shadows ?? []).map((target) =>
      yamlQuote(`${coding?.shadowSource}:${target}:ro`)
    ),
  ];

  const projectPairs = hostFolders.map((p) => [p.hostPath, p.containerPath] as const);
  const identity = (paths: readonly string[]) => paths.map((item) => [item, item] as const);
  const projectMasks = stackDataMaskLines(projectPairs, masks);
  const codingMasks = stackDataMaskLines(identity(codingRoots), masks);
  const workerMasks = stackDataMaskLines(
    [...projectPairs, ...identity(extraPaths), ...identity(codingRoots)],
    masks
  );

  const service = (name: string, binds: string[]): string =>
    binds.length ? `  ${name}:\n    volumes:\n${binds.map(volumeLine).join('\n')}\n` : '';
  const services =
    service('hermes', [...readOnlyProjectBinds, ...projectMasks]) +
    service('hermes-worker', [...projectBinds, ...extraBinds, ...codingBinds, ...workerMasks]) +
    service('hermes-webui', [...projectBinds, ...projectMasks]) +
    service('opencode', [...codingBinds, ...codingMasks]);

  return `# Generated by Boundary — do not edit by hand.
# Host-folder project binds, identity :ro context roots and identity coding roots, merged
# into each service's mounts by container path (terminal backend: ${BOUNDARY_HERMES_TERMINAL_BACKEND}).
# Do not prefix /opt/projects.
${services ? `services:\n${services}` : 'services: {}\n'}`;
}

/**
 * Create projects/<slug> in the user content folder for each host-folder project. With the ssh backend, hermes
 * mounts /opt/projects read-only, and Docker can't create a nested bind's mount point
 * inside a read-only mount, so the directory has to exist on the host first.
 */
export async function ensureProjectMountPoints(
  projects: readonly HermesProjectRecord[],
  files: StackFiles = getStackFiles()
): Promise<void> {
  for (const p of projects) {
    if (p.kind !== 'host-folder') continue;
    const slug = p.containerPath.replace(/^\/opt\/projects\//, '');
    if (!slug || slug.includes('/') || slug === '..') continue;
    await files.mkdir('userContent', `projects/${slug}`);
  }
}

export async function writeHermesProjectsOverlay(
  projects: readonly HermesProjectRecord[],
  extraRoots?: readonly string[],
  coding: CodingMounts = currentCodingMounts(projects)
): Promise<string> {
  const overlayPath = resolveHermesProjectsOverlayPath();
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  // A host that can't bind this machine's folders gets an overlay with no binds.
  if (!hasStackCapability('hostFolders')) {
    fs.writeFileSync(overlayPath, buildHermesProjectsOverlayYaml([], [], null), 'utf8');
    return overlayPath;
  }
  const extras = extraRoots ?? (await collectContextExtraRoots({ projects }));
  if (coding.shadows.length > 0) {
    ensureCodingShadowSource(coding.shadowSource);
  }
  const masks = currentStackDataMasks([
    ...projects.filter((p) => p.kind === 'host-folder').map((p) => p.hostPath),
    ...extraBindPaths(extras),
    ...coding.roots,
  ]);
  if (masks.dataDirs.length > 0) {
    ensureStackDataMaskSource(masks.source);
  }
  const yaml = buildHermesProjectsOverlayYaml(projects, extras, coding, masks);
  fs.writeFileSync(overlayPath, yaml, 'utf8');
  return overlayPath;
}

export function hermesProjectsOverlayExists(): boolean {
  return fs.existsSync(resolveHermesProjectsOverlayPath());
}

/** Unique slug among existing projects (append -2, -3, …). */
export function uniqueProjectSlug(
  baseName: string,
  existing: readonly HermesProjectRecord[],
  excludeId?: string
): string {
  return uniqueSlug(
    slugifyProjectName(baseName),
    existing.filter((p) => p.id !== excludeId).map((p) => p.slug)
  );
}

export function defaultProjectNameFromHostPath(hostPath: string): string {
  const base = path.basename(hostPath).trim();
  return base || 'Project';
}
