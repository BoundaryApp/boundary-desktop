import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStackEnv } from '../assistant/stackEnv';
import { stackFilesAt } from '../stackHost/activeStack';
import type { StackFiles } from '../stackHost/types';

// Boundary's fallback for the folders `addon.sh enable bitwarden` doesn't create (CR 0035 R1).
// The broker bind-mounts these four, and Podman refuses `up` when a source is missing.
// `vault.sh pre-up` can't create them first: it returns early until BITWARDEN_ENABLED is 1 in `.env`.
// Remove this file when the stack's `enable` creates them. Only the `.env` read goes through
// StackFiles: BITWARDEN_HOST_DATA_DIR can put the folders anywhere on this Mac, outside every
// stack location.

/** `vault.sh` `data_dir`: the environment, then `.env`, then `./data/addons/bitwarden`; `~` expands, a relative path is under the stack root. */
async function hostDataDir(files: StackFiles, root: string, env: NodeJS.ProcessEnv): Promise<string> {
  const raw = env.BITWARDEN_HOST_DATA_DIR || (await readStackEnv(files, 'stack', '.env')).BITWARDEN_HOST_DATA_DIR || './data/addons/bitwarden';
  const home = env.HOME || os.homedir();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(root, expanded);
}

/** `broker-api/api-token` under `BITWARDEN_HOST_DATA_DIR` (stack v0.3.16), and whether it holds a token. */
export async function bitwardenBrokerToken(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  files: StackFiles = stackFilesAt(root)
): Promise<{ path: string; state: 'file' | 'missing' | 'folder' }> {
  const file = path.join(await hostDataDir(files, root, env), 'broker-api', 'api-token');
  const stat = await fs.promises.stat(file).catch((): null => null);
  if (!stat) return { path: file, state: 'missing' };
  if (stat.isDirectory()) return { path: file, state: 'folder' };
  return { path: file, state: stat.size > 0 ? 'file' : 'missing' };
}

/**
 * The add-on's `secrets` folder on this Mac, which the broker mounts read-only at `/secrets`. The
 * relay writes its credential client's endpoint and token there (ADR 0065).
 */
export async function bitwardenSecretsDir(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  files: StackFiles = stackFilesAt(root)
): Promise<string> {
  return path.join(await hostDataDir(files, root, env), 'secrets');
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
  env: NodeJS.ProcessEnv = process.env,
  files: StackFiles = stackFilesAt(paths.root)
): Promise<void> {
  const hostData = await hostDataDir(files, paths.root, env);
  await ensureFolder(path.join(paths.dataRoot, 'addons', 'bitwarden', 'instances'), 0o700);
  await ensureFolder(path.join(hostData, 'bw'), 0o700);
  await ensureFolder(path.join(hostData, 'broker'), 0o700);
  await ensureFolder(path.join(hostData, 'secrets'), 0o711);
}
