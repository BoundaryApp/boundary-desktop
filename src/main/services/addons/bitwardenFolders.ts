import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvFile } from '../assistant/stackEnv';

// Boundary's fallback for the folders `addon.sh enable bitwarden` doesn't create (CR 0035 R1).
// The broker bind-mounts these four, and Podman refuses `up` when a source is missing.
// `vault.sh pre-up` can't create them first: it returns early until BITWARDEN_ENABLED is 1 in `.env`.
// Remove this file when the stack's `enable` creates them.

/** `vault.sh` `data_dir`: the environment, then `.env`, then `./data/addons/bitwarden`; `~` expands, a relative path is under the stack root. */
function hostDataDir(root: string, env: NodeJS.ProcessEnv): string {
  const raw = env.BITWARDEN_HOST_DATA_DIR || readEnvFile(path.join(root, '.env')).BITWARDEN_HOST_DATA_DIR || './data/addons/bitwarden';
  const home = env.HOME || os.homedir();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(root, expanded);
}

/** Creates `target` and any missing parents, then sets `mode` on the folders this call created only. */
async function ensureFolder(target: string, mode: number): Promise<void> {
  const existing = await fs.promises.stat(target).catch((): null => null);
  if (existing) {
    if (!existing.isDirectory()) throw new Error(`${target} exists and is not a folder`);
    return;
  }
  // The first folder mkdir makes is the first missing ancestor; mkdir's mode is masked by umask, so chmod the leaf.
  await fs.promises.mkdir(target, { recursive: true, mode });
  await fs.promises.chmod(target, mode);
}

export async function ensureBitwardenFolders(
  paths: { root: string; dataRoot: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const hostData = hostDataDir(paths.root, env);
  await ensureFolder(path.join(paths.dataRoot, 'addons', 'bitwarden', 'instances'), 0o700);
  await ensureFolder(path.join(hostData, 'bw'), 0o700);
  await ensureFolder(path.join(hostData, 'broker'), 0o700);
  await ensureFolder(path.join(hostData, 'secrets'), 0o711);
}
