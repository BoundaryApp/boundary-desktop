import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export type DarwinRuntimeArch = 'arm64' | 'x64';

export const BOUNDARY_MACHINE_NAME = 'boundary';

/**
 * Memory for the bundled `boundary` Podman machine (MiB).
 * Podman's default is 2048 — far too small for neo4j (~1.5G) plus the rest of
 * the assistant stack (~9–12G containers). See ASSISTANT_STACK_REQUIREMENTS.
 */
export const BOUNDARY_MACHINE_MEMORY_MIB = 12_288;

/** Disk for the bundled machine (GiB). Matches podman default. */
export const BOUNDARY_MACHINE_DISK_GIB = 100;

/**
 * Map process.arch to our on-disk asset folder name.
 */
export function darwinRuntimeArch(
  arch: NodeJS.Architecture = process.arch
): DarwinRuntimeArch | null {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'x64';
  return null;
}

function tryUserDataRoot(): string {
  try {
    return app.getPath('userData');
  } catch {
    return path.join(os.homedir(), '.boundary-desktop');
  }
}

/**
 * Directory that holds private containers.conf and machine-related state.
 */
export function getContainerRuntimeStateDir(
  userDataRoot: string = tryUserDataRoot()
): string {
  return path.join(userDataRoot, 'container-runtime');
}

/**
 * Resolve the packaged (or dev) root for a given darwin arch.
 * Packaged: `<Resources>/container-runtime/darwin-<arch>`
 * Dev: `resources/container-runtime/darwin-<arch>` next to the repo root.
 */
export function listBundledRuntimeRootCandidates(
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    resourcesPath?: string;
    projectRoot?: string;
  } = {}
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return [];
  }
  const arch = darwinRuntimeArch(options.arch ?? process.arch);
  if (!arch) {
    return [];
  }

  const folder = `darwin-${arch}`;
  const candidates: string[] = [];

  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'container-runtime', folder));
  }

  // electron-forge may nest extraResources under app.asar.unpacked sibling Resources
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'resources', 'container-runtime', folder));
  }

  const projectRoot =
    options.projectRoot ??
    (typeof app?.getAppPath === 'function'
      ? path.resolve(app.getAppPath(), '..', '..')
      : process.cwd());
  candidates.push(path.join(projectRoot, 'resources', 'container-runtime', folder));
  candidates.push(path.join(process.cwd(), 'resources', 'container-runtime', folder));

  return candidates;
}

/**
 * Resolve the packaged (or dev) root for a given darwin arch.
 * Packaged: `<Resources>/container-runtime/darwin-<arch>`
 * Dev: `resources/container-runtime/darwin-<arch>` next to the repo root.
 */
export function getBundledRuntimeRoot(
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    resourcesPath?: string;
    projectRoot?: string;
  } = {}
): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return null;
  }
  const arch = darwinRuntimeArch(options.arch ?? process.arch);
  if (!arch) {
    return null;
  }

  const candidates = listBundledRuntimeRootCandidates(options);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'bin', 'podman'))) {
      return candidate;
    }
  }

  // Return the preferred packaged path even if not populated (callers check exists).
  return candidates[0] ?? null;
}

export type BundledRuntimePaths = {
  root: string;
  binDir: string;
  /** Same as binDir: gvproxy / krunkit / vfkit live next to podman. */
  helperDir: string;
  libDir: string;
  firmwarePath: string;
  podmanPath: string;
  composePath: string;
  machineImagePath: string | null;
  stateDir: string;
  containersConfPath: string;
};

export function resolveBundledRuntimePaths(
  options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    resourcesPath?: string;
    projectRoot?: string;
    userDataRoot?: string;
  } = {}
): BundledRuntimePaths | null {
  const root = getBundledRuntimeRoot(options);
  if (!root) {
    return null;
  }

  const binDir = path.join(root, 'bin');
  const helperDir = binDir;
  const libDir = path.join(root, 'lib');
  const firmwarePath = path.join(root, 'share', 'krunkit', 'KRUN_EFI.silent.fd');
  const podmanPath = path.join(binDir, 'podman');
  const composePath = path.join(binDir, 'docker-compose');
  const machineDir = path.join(root, 'machine');
  const machineCandidates = ['machine-os.zst', 'machine-os.raw', 'podman-machine.zst'];
  let machineImagePath: string | null = null;
  for (const name of machineCandidates) {
    const p = path.join(machineDir, name);
    if (fs.existsSync(p)) {
      machineImagePath = p;
      break;
    }
  }

  const stateDir = getContainerRuntimeStateDir(options.userDataRoot ?? tryUserDataRoot());
  return {
    root,
    binDir,
    helperDir,
    libDir,
    firmwarePath,
    podmanPath,
    composePath,
    machineImagePath,
    stateDir,
    containersConfPath: path.join(stateDir, 'containers.conf'),
  };
}

function hasLibkrunDylib(libDir: string): boolean {
  if (fs.existsSync(path.join(libDir, 'libkrun.dylib'))) {
    return true;
  }
  try {
    return fs.readdirSync(libDir).some((name) => /^libkrun.*\.dylib$/i.test(name));
  } catch {
    return false;
  }
}

export function bundledRuntimeAssetsPresent(paths: BundledRuntimePaths): boolean {
  if (!fs.existsSync(paths.podmanPath) || !fs.existsSync(paths.composePath)) {
    return false;
  }
  if (!fs.existsSync(path.join(paths.helperDir, 'gvproxy'))) {
    return false;
  }
  if (paths.root.includes('darwin-x64')) {
    return fs.existsSync(path.join(paths.helperDir, 'vfkit'));
  }
  return (
    fs.existsSync(path.join(paths.helperDir, 'krunkit')) &&
    hasLibkrunDylib(paths.libDir) &&
    fs.existsSync(paths.firmwarePath)
  );
}

export function machineProviderForArch(
  arch: DarwinRuntimeArch = darwinRuntimeArch() ?? 'arm64'
): 'libkrun' | 'applehv' {
  return arch === 'arm64' ? 'libkrun' : 'applehv';
}
