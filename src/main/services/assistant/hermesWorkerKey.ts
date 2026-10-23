import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type KeygenRunner = (args: string[]) => Promise<unknown>;

const defaultKeygen: KeygenRunner = (args) =>
  execFileAsync('ssh-keygen', args, { timeout: 30_000 });

export function hermesWorkerKeyPath(projectRoot: string): string {
  return path.join(projectRoot, 'compose', 'hermes', 'worker', 'ssh', 'id_ed25519');
}

/**
 * The worker's authorized_keys is the public half of compose/hermes/worker/ssh/id_ed25519.
 * setup.sh creates the pair, but if either half is gone the worker exits and hermes waits
 * on it forever, so make a new pair rather than fail the start. Returns true when it did.
 */
export async function ensureHermesWorkerKey(
  projectRoot: string,
  keygen: KeygenRunner = defaultKeygen
): Promise<boolean> {
  const key = hermesWorkerKeyPath(projectRoot);
  if (fs.existsSync(key) && fs.existsSync(`${key}.pub`)) return false;
  await fs.promises.mkdir(path.dirname(key), { recursive: true });
  await fs.promises.rm(key, { force: true });
  await fs.promises.rm(`${key}.pub`, { force: true });
  await keygen(['-t', 'ed25519', '-f', key, '-N', '', '-C', 'hermes-worker']);
  await fs.promises.chmod(key, 0o600);
  await fs.promises.chmod(`${key}.pub`, 0o644);
  return true;
}
