import fs from 'node:fs';
import path from 'node:path';
import type { CodingGrantRefuseReason } from '../../../../shared/types/codingFolders';
import { canonicalPath, isPathUnder, samePath } from '../../hostPaths';

/**
 * Pure rules for coding grants (ADR 0028 §4–§6): which folders may be granted, how grants
 * become `CODING_EXTRA_ROOTS`, and which secrets get an empty read-only shadow.
 */

/** macOS system trees. A grant at or under any of these is refused (ADR 0028 §5). */
const SYSTEM_FOLDERS = [
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/private',
  '/dev',
  '/cores',
];

export interface CodingGrantRuleOptions {
  home: string;
  /** Boundary's own trees: userData and the stack home. */
  boundaryDataPaths: readonly string[];
  /** Defaults to {@link SYSTEM_FOLDERS}. */
  systemFolders?: readonly string[];
  /** Override for tests; defaults to a directory check on disk. */
  isDirectory?: (candidate: string) => boolean;
  /** Override for tests; defaults to `fs.realpathSync` when the path exists. */
  realpath?: (candidate: string) => string;
}

/** Whether the path is a directory on disk, and whether that directory has a `.git`. */
export function folderFacts(hostPath: string): { isDirectory: boolean; isGit: boolean } {
  let isDirectory: boolean;
  try {
    isDirectory = fs.statSync(hostPath).isDirectory();
  } catch {
    isDirectory = false;
  }
  return { isDirectory, isGit: isDirectory && fs.existsSync(path.join(hostPath, '.git')) };
}

function defaultIsDirectory(candidate: string): boolean {
  return folderFacts(candidate).isDirectory;
}

function refuseResolved(
  resolved: string,
  options: CodingGrantRuleOptions
): CodingGrantRefuseReason | null {
  if (resolved === path.resolve('/')) return 'root';
  if (samePath(resolved, options.home)) return 'home';
  if (isPathUnder(options.home, resolved)) return 'home-ancestor';
  const userLibrary = path.join(options.home, 'Library');
  if (
    isPathUnder(resolved, userLibrary) ||
    (options.systemFolders ?? SYSTEM_FOLDERS).some((folder) => isPathUnder(resolved, folder))
  ) {
    return 'system';
  }
  for (const own of options.boundaryDataPaths) {
    if (isPathUnder(resolved, own)) return 'boundary-data';
    if (isPathUnder(own, resolved)) return 'contains-boundary-data';
  }
  return null;
}

/**
 * Why a folder can't be a coding grant, or null when it can. Checks the path as given and
 * with symlinks resolved, so `/tmp/x` (really `/private/tmp/x`) is judged by where it lands.
 */
export function refuseCodingGrantReason(
  hostPath: string,
  options: CodingGrantRuleOptions
): CodingGrantRefuseReason | null {
  const trimmed = hostPath.trim();
  if (!path.isAbsolute(trimmed)) return 'not-absolute';
  // A colon would split CODING_EXTRA_ROOTS and a compose bind; a newline would split .env.
  if (/[:\n\r]/.test(trimmed)) return 'unsupported-characters';
  const resolved = path.resolve(trimmed);
  const reason = refuseResolved(resolved, options);
  if (reason) return reason;
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  if (!isDirectory(resolved)) return 'missing';
  const real = path.resolve((options.realpath ?? canonicalPath)(resolved));
  if (real !== resolved) {
    const realReason = refuseResolved(real, options);
    if (realReason) return realReason;
  }
  return null;
}

export function codingGrantRefuseMessage(reason: CodingGrantRefuseReason): string {
  switch (reason) {
    case 'not-absolute':
      return 'Choose a folder by its full path.';
    case 'unsupported-characters':
      return 'Folder paths with a colon or a line break can’t be shared with the coding agent. Rename the folder and try again.';
    case 'root':
      return 'The whole disk can’t be shared with the coding agent. Choose a project folder.';
    case 'home':
      return 'Your home folder is too broad. Choose a folder inside it.';
    case 'home-ancestor':
      return 'That folder contains your home folder. Choose a folder inside your home folder.';
    case 'system':
      return 'System and Library folders can’t be shared with the coding agent.';
    case 'boundary-data':
      return 'That folder holds Boundary’s own data, which stays out of the agents’ reach.';
    case 'contains-boundary-data':
      return 'That folder contains Boundary’s own data. Choose a folder that doesn’t.';
    case 'missing':
      return 'That folder doesn’t exist.';
  }
}

/**
 * Grant paths as mount roots: resolved, deduplicated, and without any path that sits inside
 * another root, since the parent's bind already covers it.
 */
export function codingRootsFromPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map((item) => path.resolve(item)))];
  const roots = unique.filter(
    (candidate) => !unique.some((other) => other !== candidate && isPathUnder(candidate, other))
  );
  return roots.sort((left, right) => left.localeCompare(right));
}

/**
 * `CODING_EXTRA_ROOTS` as the stack reads it. The leading colon matters: the base compose
 * file appends the value straight onto `HERMES_WRITE_SAFE_ROOT`.
 */
export function serializeCodingExtraRoots(roots: readonly string[]): string {
  return roots.length > 0 ? `:${roots.join(':')}` : '';
}

const ENV_FILE = /^\.env(\..+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template)$/;

/** Top-level `.env` and `.env.*` files in a folder, minus templates (ADR 0028 §6). */
export function envShadowTargets(
  folder: string,
  readdir: (dir: string) => fs.Dirent[] = (dir) => fs.readdirSync(dir, { withFileTypes: true })
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = readdir(folder);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && ENV_FILE.test(entry.name) && !ENV_TEMPLATE.test(entry.name))
    .map((entry) => path.join(folder, entry.name))
    .filter((target) => !/[:\n\r]/.test(target))
    .sort((left, right) => left.localeCompare(right));
}

/** Characters the alias format uses as separators, plus a quote that would break `.env`. */
const ALIAS_UNSAFE = /[;=\n\r']/;

/**
 * `CODING_PATH_ALIASES` (stack change request 0003 R2): one `/opt/projects/<slug>=<host path>`
 * pair per host-folder project, so `opencode-mcp` accepts the path Hermes already has. An
 * alias grants nothing. Paths containing a separator can't be expressed and are left out.
 */
export function codingPathAliases(
  projects: ReadonlyArray<{ kind: string; hostPath: string; containerPath: string }>
): string {
  return projects
    .filter((project) => project.kind === 'host-folder' && project.containerPath && project.hostPath)
    .map((project) => ({
      alias: project.containerPath.replace(/\/+$/, ''),
      host: path.resolve(project.hostPath),
    }))
    .filter(({ alias, host }) => !ALIAS_UNSAFE.test(alias) && !ALIAS_UNSAFE.test(host))
    .map(({ alias, host }) => `${alias}=${host}`)
    .sort((left, right) => left.localeCompare(right))
    .join(';');
}
