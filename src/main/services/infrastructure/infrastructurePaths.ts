import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface InfrastructureRootOptions {
  envRoot?: string;
  cwd?: string;
  resourcesPath?: string;
  appPath?: string;
}

function tryGetAppPath(): string | undefined {
  try {
    if (typeof app.getAppPath === 'function') {
      return app.getAppPath();
    }
  } catch {
    // app may be unavailable in unit tests
  }
  return undefined;
}

/** True when `root` contains bundled catalog, recipes, or legacy manifests. */
export function hasInfrastructureTree(root: string): boolean {
  return (
    fs.existsSync(path.join(root, 'infrastructure', 'catalog', 'models.json')) ||
    fs.existsSync(path.join(root, 'infrastructure', 'recipes')) ||
    fs.existsSync(path.join(root, 'infrastructure', 'manifests'))
  );
}

/**
 * Candidate directories that may contain `infrastructure/`.
 * Packaged apps ship the tree under `process.resourcesPath` (extra resources)
 * or `app.getAppPath()` (asar). Dev uses the repo cwd.
 */
export function listInfrastructureRootCandidates(
  options: InfrastructureRootOptions
): string[] {
  const candidates: string[] = [];
  if (options.envRoot) {
    candidates.push(options.envRoot);
  }
  if (options.resourcesPath) {
    candidates.push(options.resourcesPath);
  }
  if (options.appPath) {
    candidates.push(options.appPath);
    candidates.push(path.join(options.appPath, '..', '..'));
    candidates.push(path.join(options.appPath, '..', '..', '..'));
  }
  if (options.cwd) {
    candidates.push(options.cwd);
  }
  return candidates;
}

export function resolveInfrastructureRoot(options: InfrastructureRootOptions): string {
  const candidates = listInfrastructureRootCandidates(options);
  for (const candidate of candidates) {
    if (hasInfrastructureTree(candidate)) {
      return path.resolve(candidate);
    }
  }
  return path.resolve(options.cwd || options.envRoot || '.');
}

/** Repo root (dev) or packaged resources / asar root that contains `infrastructure/`. */
export function getRepoRoot(): string {
  const options: InfrastructureRootOptions = {
    envRoot: process.env.BOUNDARY_REPO_ROOT,
    cwd: process.cwd(),
    resourcesPath:
      typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined,
    appPath: tryGetAppPath(),
  };
  return resolveInfrastructureRoot(options);
}

export function getManifestsDir(): string {
  return path.join(getRepoRoot(), 'infrastructure', 'manifests');
}

export function getCatalogPath(): string {
  return path.join(getRepoRoot(), 'infrastructure', 'catalog', 'models.json');
}

export function getRecipesDir(): string {
  return path.join(getRepoRoot(), 'infrastructure', 'recipes');
}

export function getBundledModuleDir(modulePath: string): string {
  return path.join(getRepoRoot(), 'infrastructure', modulePath);
}

export function getProfilesDir(): string {
  return path.join(getRepoRoot(), 'infrastructure', 'profiles');
}

export function resolveProfilePath(profilePath: string): string {
  return path.join(getRepoRoot(), 'infrastructure', profilePath);
}

export function getInfrastructureUserDir(): string {
  return path.join(app.getPath('userData'), 'infrastructure');
}

export function getInstanceWorkspaceDir(instanceId: string): string {
  return path.join(getInfrastructureUserDir(), instanceId);
}

export function getInstancesIndexPath(): string {
  return path.join(getInfrastructureUserDir(), 'instances.json');
}
