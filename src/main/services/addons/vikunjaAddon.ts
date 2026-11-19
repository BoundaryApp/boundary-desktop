import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from '../assistant/stackEnv';
import {
  enableAddon,
  findListEntry,
  readStackFile,
  type AddonScriptLine,
  type AddonScriptOutcome,
  type PlainOutcome,
} from './addonScript';
import type { ScriptAddonDeps } from './scriptAddonInstaller';

// Todo lists (Vikunja, CR 0032, stack 0.3.15). The stack keeps everything: `addon.sh enable
// vikunja` registers the database schema (hook `prepare`), starts `vikunja` and `vikunja-proxy`,
// creates the account and mints the agents' tokens (hook `init`). Boundary holds no password or
// token; it opens the signed-in web app at the URL `addon.sh list --json` reports.

/** `enable` pulls two images and runs `init` on its first run. */
const ENABLE_TIMEOUT_MS = 1_800_000;
const LIST_TIMEOUT_MS = 60_000;

/** The stack tree offers Todo lists: `addon.sh`, and a manifest with the `prepare` hook (0.3.15). */
export function vikunjaAvailable(root: string, read: (p: string) => string | null = readStackFile): boolean {
  const manifest = read(path.join(root, 'addons', 'vikunja', 'addon.json'));
  if (manifest === null || read(path.join(root, 'scripts', 'addon.sh')) === null) return false;
  try {
    const m = JSON.parse(manifest) as { hooks?: { prepare?: unknown } };
    return Boolean(m.hooks?.prepare);
  } catch {
    return false;
  }
}

const on = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? '').trim());

/** `VIKUNJA_MCP_ENABLED` in the stack's `.env`, which `addon.sh enable` and `disable` write. */
export function readVikunjaEnabled(root: string): boolean {
  return on(readEnvFile(path.join(root, '.env')).VIKUNJA_MCP_ENABLED);
}

/**
 * Whether an earlier install's lists are on this Mac: `init` succeeded once (`addon_cli.py` records
 * it in `<data root>/addons/vikunja/state.json` only after the hook passes) and the files folder
 * (`VIKUNJA_FILES_DIR`, default `./data/vikunja/files`, relative to the stack root) is still there.
 * Neither alone says it: `todo.sh prepare` creates the folder on every `enable`, before anything
 * can fail, and `remove --delete-data` deletes the folder but keeps `state.json`.
 */
export function vikunjaDataLeft(
  root: string,
  dataRoot: string,
  read: (p: string) => string | null = readStackFile,
  exists: (p: string) => boolean = fs.existsSync
): boolean {
  const dir = readEnvFile(path.join(root, '.env')).VIKUNJA_FILES_DIR?.trim() || './data/vikunja/files';
  if (!exists(path.resolve(root, dir))) return false;
  const state = read(path.join(dataRoot, 'addons', 'vikunja', 'state.json'));
  if (state === null) return false;
  try {
    const parsed = JSON.parse(state) as unknown;
    return isRecord(parsed) && isRecord(parsed.init);
  } catch {
    return false;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

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
    refresh: async () => ({ enabled: readVikunjaEnabled(deps.paths().root) }),
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
