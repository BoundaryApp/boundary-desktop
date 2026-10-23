import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import type Store from 'electron-store';

let storeRef: Store<Record<string, unknown>> | null = null;

const APP_INSTALL_PATHS_KEY = 'appInstallPaths';

/**
 * Must be called from main after electron-store is created.
 */
export function configureResolveAppPathStore(store: Store<Record<string, unknown>>): void {
  storeRef = store;
}

/** Persisted so apps installed outside `userData/apps/<id>` can still be resolved. */
export function rememberAppInstallPath(appId: string, installPath: string): void {
  if (!storeRef || !appId || !installPath) return;
  const prev = (storeRef.get(APP_INSTALL_PATHS_KEY) as Record<string, string> | undefined) ?? {};
  storeRef.set(APP_INSTALL_PATHS_KEY, { ...prev, [appId]: installPath });
}

export function forgetAppInstallPath(appId: string): void {
  if (!storeRef || !appId) return;
  const prev = (storeRef.get(APP_INSTALL_PATHS_KEY) as Record<string, string> | undefined) ?? {};
  if (!(appId in prev)) return;
  const next = { ...prev };
  delete next[appId];
  storeRef.set(APP_INSTALL_PATHS_KEY, next);
}

async function isUsableInstallRoot(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
  } catch {
    return false;
  }
  const markers = ['package.json', '.boundary-app-info.json', 'boundary.json', 'manifest.json'];
  for (const m of markers) {
    try {
      await fs.access(path.join(dir, m));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** True if the directory can run as an app (npm/boundary scripts or compose), not manifest-only stubs. */
export async function hasRunnableAppArtifacts(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, 'package.json'));
    return true;
  } catch {
    /* continue */
  }
  const composeNames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as const;
  for (const name of composeNames) {
    try {
      await fs.access(path.join(dir, name));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** Only records paths that contain a real app tree (avoids manifest-only fixture dirs). */
export async function rememberAppInstallPathIfRunnable(appId: string, installPath: string): Promise<void> {
  if (await hasRunnableAppArtifacts(installPath)) {
    rememberAppInstallPath(appId, installPath);
  }
}

/**
 * Under each parent (e.g. `userData/apps` or a registered local app root), find a child directory
 * whose `.boundary-app-info.json` declares `appId`, then return a usable install path.
 */
async function scanParentDirsForAppMetadata(parentDirs: string[], appId: string): Promise<string | null> {
  const seenParents = new Set<string>();
  for (const parent of parentDirs) {
    if (!parent || seenParents.has(parent)) continue;
    seenParents.add(parent);
    try {
      const dirents = await fs.readdir(parent, { withFileTypes: true });
      for (const ent of dirents) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(parent, ent.name);
        const metaPath = path.join(dir, '.boundary-app-info.json');
        try {
          const raw = await fs.readFile(metaPath, 'utf8');
          const metadata = JSON.parse(raw) as {
            appId?: string;
            localPath?: string;
            installPath?: string;
          };
          if (metadata.appId !== appId) continue;
          const candidates = [metadata.installPath, metadata.localPath, dir].filter(
            (p): p is string => typeof p === 'string' && p.length > 0
          );
          for (const p of candidates) {
            if ((await isUsableInstallRoot(p)) && (await hasRunnableAppArtifacts(p))) return p;
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve installed app directory for an app id.
 * Managed installs from the installer live under `userData/apps/<appId>`; `localAppDirectories`
 * remains for dev discovery of apps outside that tree.
 * @param hintInstallPath — optional absolute path from renderer (Dexie) when the app is not under the default folder.
 */
export async function resolveAppPath(appId: string, hintInstallPath?: string | null): Promise<string | null> {
  if (!storeRef) {
    console.error('resolveAppPath: store not configured');
    return null;
  }

  try {
    const userDataPath = app.getPath('userData');
    const appsDir = path.join(userDataPath, 'apps');
    const standardAppPath = path.join(appsDir, appId);
    const localDirectories = storeRef.get('localAppDirectories', []) as string[];
    const metadataScanRoots = [appsDir, ...localDirectories];

    // 1) Prefer runnable clone under userData/apps/<id> over Dexie hints (stale manifest-only paths).
    try {
      await fs.access(standardAppPath);
      if (await hasRunnableAppArtifacts(standardAppPath)) {
        rememberAppInstallPath(appId, standardAppPath);
        return standardAppPath;
      }
    } catch {
      // standard dir missing
    }

    const storedMap = (storeRef.get(APP_INSTALL_PATHS_KEY) as Record<string, string> | undefined) ?? {};
    const stored = storedMap[appId];
    if (stored && (await isUsableInstallRoot(stored))) {
      if (await hasRunnableAppArtifacts(stored)) {
        return stored;
      }
      forgetAppInstallPath(appId);
    }

    if (
      hintInstallPath &&
      (await isUsableInstallRoot(hintInstallPath)) &&
      (await hasRunnableAppArtifacts(hintInstallPath))
    ) {
      rememberAppInstallPath(appId, hintInstallPath);
      return hintInstallPath;
    }

    for (const localDir of localDirectories) {
      const potentialAppPath = path.join(localDir, appId);
      try {
        await fs.access(potentialAppPath);
        const boundaryJsonPath = path.join(potentialAppPath, 'boundary.json');
        await fs.access(boundaryJsonPath);
        if (await hasRunnableAppArtifacts(potentialAppPath)) {
          rememberAppInstallPath(appId, potentialAppPath);
          return potentialAppPath;
        }
      } catch {
        continue;
      }
    }

    const scanned = await scanParentDirsForAppMetadata(metadataScanRoots, appId);
    if (scanned && (await hasRunnableAppArtifacts(scanned))) {
      rememberAppInstallPath(appId, scanned);
      return scanned;
    }

    return null;
  } catch (error) {
    console.error('Error resolving app path:', error);
    return null;
  }
}
