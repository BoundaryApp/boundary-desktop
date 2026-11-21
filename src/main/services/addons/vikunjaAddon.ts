import fs from 'node:fs';
import path from 'node:path';
import { readStackEnv } from '../assistant/stackEnv';
import type { StackFiles } from '../stackHost/types';
import {
  enableAddon,
  findListEntry,
  flagOn,
  readStackFile,
  type AddonScriptLine,
  type AddonScriptOutcome,
  type PlainOutcome,
} from './addonScript';
import type { ScriptAddonDeps } from './scriptAddonInstaller';
import { copyThenClear, type SecretClipboard } from './secretClipboard';
import { stackFilesAt } from '../stackHost/activeStack';
import { isRecord } from '../../../shared/utils/isRecord';

// Todo lists (Vikunja, CR 0032, stack 0.3.15). The stack keeps everything: `addon.sh enable
// vikunja` registers the database schema (hook `prepare`), starts `vikunja` and `vikunja-proxy`,
// creates the account and mints the agents' tokens (hook `init`). Boundary holds no password or
// token; it opens the signed-in web app at the URL `addon.sh list --json` reports.

/** `enable` pulls two images and runs `init` on its first run. */
const ENABLE_TIMEOUT_MS = 1_800_000;
const LIST_TIMEOUT_MS = 60_000;

/** The stack tree offers Todo lists: `addon.sh`, and a manifest with the `prepare` hook (0.3.15). */
export async function vikunjaAvailable(files: StackFiles): Promise<boolean> {
  const manifest = await readStackFile(files, 'addons/vikunja/addon.json');
  if (manifest === null || (await readStackFile(files, 'scripts/addon.sh')) === null) return false;
  try {
    const m = JSON.parse(manifest) as { hooks?: { prepare?: unknown } };
    return Boolean(m.hooks?.prepare);
  } catch {
    return false;
  }
}

/** `VIKUNJA_MCP_ENABLED` in the stack's `.env`, which `addon.sh enable` and `disable` write. */
export async function readVikunjaEnabled(files: StackFiles): Promise<boolean> {
  return flagOn((await readStackEnv(files, 'stack', '.env')).VIKUNJA_MCP_ENABLED);
}

/**
 * The account `/login-local` signs in as: `todo.sh init` writes `VIKUNJA_USERNAME` and a generated
 * `VIKUNJA_PASSWORD` to the stack's `.env` (stack 0.3.15). The username can be an account the
 * stack adopted, so it's read, not assumed. Null while Todo lists is off or before `init`:
 * `addon.sh remove` leaves both keys in `.env`, and they'd name an account that's gone.
 */
export async function readVikunjaLogin(files: StackFiles): Promise<{ username: string; password: string } | null> {
  const env = await readStackEnv(files, 'stack', '.env');
  if (!flagOn(env.VIKUNJA_MCP_ENABLED)) return null;
  const username = env.VIKUNJA_USERNAME?.trim() ?? '';
  const password = env.VIKUNJA_PASSWORD ?? '';
  return username && password ? { username, password } : null;
}

/** The username to show beside Copy password; the password stays in main. */
export async function vikunjaAccount(files: StackFiles): Promise<{ username: string } | null> {
  const login = await readVikunjaLogin(files);
  return login ? { username: login.username } : null;
}

/** Copies the account's password, cleared after 60 s. False when there's no login to copy. */
export async function copyVikunjaPassword(deps: {
  files: StackFiles;
  clipboard: SecretClipboard;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): Promise<boolean> {
  const login = await readVikunjaLogin(deps.files);
  if (!login) return false;
  await copyThenClear(deps.clipboard, login.password, deps.setTimer);
  return true;
}

/**
 * Whether an earlier install's lists are on this Mac: `init` succeeded once (`addon_cli.py` records
 * it in `<data root>/addons/vikunja/state.json` only after the hook passes) and the files folder
 * (`VIKUNJA_FILES_DIR`, default `./data/vikunja/files`, relative to the stack root) is still there.
 * Neither alone says it: `todo.sh prepare` creates the folder on every `enable`, before anything
 * can fail, and `remove --delete-data` deletes the folder but keeps `state.json`.
 */
export async function vikunjaDataLeft(files: StackFiles, root: string): Promise<boolean> {
  const dir = (await readStackEnv(files, 'stack', '.env')).VIKUNJA_FILES_DIR?.trim() || './data/vikunja/files';
  if (!(await filesFolderExists(files, root, dir))) return false;
  const state = await files.readText('userContent', 'addons/vikunja/state.json');
  if (state === null) return false;
  try {
    const parsed = JSON.parse(state) as unknown;
    return isRecord(parsed) && isRecord(parsed.init);
  } catch {
    return false;
  }
}

/**
 * Whether the folder `VIKUNJA_FILES_DIR` names exists. A path inside the stack folder is asked of
 * `files`; one elsewhere on this Mac, which the setting allows, is checked directly.
 */
async function filesFolderExists(files: StackFiles, root: string, dir: string): Promise<boolean> {
  const resolved = path.resolve(root, dir);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return fs.existsSync(resolved);
  return files.exists('stack', rel);
}

/** The vikunja entry of `addon.sh list --json`: whether it's on and its `web.url`. Null without one. */
export function parseVikunjaListing(stdout: string): { enabled: boolean; webUrl: string | null } | null {
  const entry = findListEntry(stdout, 'vikunja');
  if (!entry) return null;
  const web = isRecord(entry.web) ? entry.web : null;
  return { enabled: entry.enabled === true, webUrl: typeof web?.url === 'string' ? web.url : null };
}

/** `url` when it is http on localhost or 127.0.0.1 with a port, else null. */
export function loopbackWebUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || !parsed.port) return null;
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString();
}

/** `log` takes counts, codes and outcomes only. */
export interface VikunjaServiceDeps extends Pick<ScriptAddonDeps<unknown>, 'paths' | 'run' | 'log'> {
  plain(args: string[], options?: { timeoutMs?: number }): Promise<PlainOutcome>;
}

export interface VikunjaService {
  /** `addon.sh enable vikunja --json`, under the caller's lock. */
  enable(options?: { onLine?: (l: AddonScriptLine) => void }): Promise<AddonScriptOutcome>;
  /** Whether it's on, from the stack's `.env`. */
  refresh(): Promise<{ enabled: boolean }>;
  /** The web app's URL to open, or the line to show instead. */
  webUrl(): Promise<{ url: string } | { error: string }>;
}

export function createVikunjaService(deps: VikunjaServiceDeps): VikunjaService {
  return {
    enable: (options = {}) => enableAddon(deps, 'vikunja', { timeoutMs: ENABLE_TIMEOUT_MS, onLine: options.onLine }),
    refresh: async () => ({ enabled: await readVikunjaEnabled(stackFilesAt(deps.paths().root)) }),
    webUrl: async () => {
      const outcome = await deps.plain(['list', '--json'], { timeoutMs: LIST_TIMEOUT_MS });
      if (outcome.code !== 0) {
        deps.log('list failed', { code: outcome.code });
        return { error: `Couldn’t read the add-on list (addon.sh exited with code ${outcome.code}).` };
      }
      const listing = parseVikunjaListing(outcome.stdout);
      if (!listing) return { error: 'The stack doesn’t list Todo lists.' };
      if (!listing.enabled) return { error: 'Todo lists is off. Turn it on, then open it.' };
      if (listing.webUrl === null) return { error: 'The stack reports no published port for Todo lists, so there’s nothing to open.' };
      const url = loopbackWebUrl(listing.webUrl);
      deps.log('open', { loopback: url !== null });
      return url ? { url } : { error: 'The stack gave an address outside this Mac, so Boundary didn’t open it.' };
    },
  };
}
