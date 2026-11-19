import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AddonCatalogEntry } from '../../../shared/types/addons';
import { upsertEnvLines } from '../assistant/stackEnv';

const SYNC_TIMEOUT_MS = 60_000;

export interface LocalStackAddonFlagsDeps {
  exists(p: string): boolean;
  readFile(p: string): string;
  writeFile(p: string, contents: string): void;
  /** Runs `bash scripts/sync-profiles.sh` in `root`. Resolves with its exit code and output. */
  syncProfiles(root: string): Promise<{ code: number; output: string }>;
}

/**
 * Records an add-on's flags in a local stack checkout's `.env`, so the stack's own `make up`
 * starts what Boundary installed. Writes each of the add-on's flags with its value in `flags`
 * (the values Boundary's own compose calls pass) and runs `scripts/sync-profiles.sh`, which adds
 * or removes the add-on's profile in COMPOSE_PROFILES. Stack 0.3.10's `make up` runs the same
 * sync, so a stack without the script still gets the flags. Throws when `flags` lacks one of the
 * add-on's flags, or a write or the sync fails.
 */
export async function writeLocalStackAddonFlags(
  root: string,
  entry: AddonCatalogEntry,
  flags: Record<string, '0' | '1'>,
  deps: LocalStackAddonFlagsDeps = defaultLocalStackAddonFlagsDeps()
): Promise<void> {
  const missing = entry.flags.find((flag) => !(flag in flags));
  if (missing) throw new Error(`No value for ${missing}.`);
  const envPath = path.join(root, '.env');
  if (!deps.exists(envPath)) {
    throw new Error(`The stack checkout has no .env at ${envPath}.`);
  }
  const before = deps.readFile(envPath);
  const values = Object.fromEntries(entry.flags.map((flag) => [flag, flags[flag]!]));
  const after = upsertEnvLines(before, values);
  if (after !== before) deps.writeFile(envPath, after);

  if (!deps.exists(path.join(root, 'scripts', 'sync-profiles.sh'))) return;
  const { code, output } = await deps.syncProfiles(root);
  if (code !== 0) {
    const tail = output.trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(
      `The stack's sync-profiles.sh exited with code ${code}${tail ? `: ${tail}` : ''}.`
    );
  }
}

/** Runs the stack's profile sync. 127 when bash can't start, 124 after the timeout. */
export function runSyncProfiles(
  root: string,
  spawnImpl: typeof spawn = spawn,
  timeoutMs = SYNC_TIMEOUT_MS
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const child = spawnImpl('bash', ['scripts/sync-profiles.sh'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => (output += String(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => (output += String(chunk)));
    child.on('error', (error: Error) => {
      output += error.message;
      finish(127);
    });
    child.on('close', (code: number | null) => finish(timedOut ? 124 : (code ?? 1)));
  });
}

function defaultLocalStackAddonFlagsDeps(): LocalStackAddonFlagsDeps {
  return {
    exists: fs.existsSync,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    writeFile: (p, contents) => fs.writeFileSync(p, contents, 'utf8'),
    syncProfiles: (root) => runSyncProfiles(root),
  };
}
