import type { TwentyAccess, TwentyWorkspace } from '../../../shared/types/addons';
import { ADDON_SLUG } from '../../../shared/utils/slug';
import type { StackFiles } from '../stackHost/types';
import { parseEnv, upsertEnvLines } from '../assistant/stackEnv';
import { isRecord } from '../../../shared/utils/isRecord';

const LOCAL_URL = 'http://twenty-server:3000';

/**
 * The Twenty add-on's store (stack v0.3.13), under the user-content location, where `crm.sh`
 * writes it and the Hermes bootstraps mount it: `instances/<slug>.json` holds a workspace's
 * settings, `secrets/<slug>.key_ro` and `.key_rw` its API keys.
 */
export const TWENTY_STORE = 'addons/twenty';

const instanceFile = (slug: string) => `${TWENTY_STORE}/instances/${slug}.json`;
const secretFile = (slug: string, name: 'key_ro' | 'key_rw') => `${TWENTY_STORE}/secrets/${slug}.${name}`;

interface InstanceValues {
  url?: unknown;
  access?: unknown;
  local?: unknown;
  workspace_url?: unknown;
  workspace_id?: unknown;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

async function slugs(files: StackFiles): Promise<string[]> {
  let names: string[] | null;
  try {
    names = await files.list('userContent', `${TWENTY_STORE}/instances`);
  } catch {
    return [];
  }
  return (names ?? [])
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((slug) => ADDON_SLUG.test(slug));
}

async function readValues(files: StackFiles, slug: string): Promise<InstanceValues | null> {
  try {
    const v = JSON.parse((await files.readText('userContent', instanceFile(slug))) ?? 'null') as unknown;
    return isRecord(v) ? (v as InstanceValues) : null;
  } catch {
    return null;
  }
}

/** The store counts a secret as set when its file is non-empty (`addon_store._secret_set`). */
async function hasSecret(files: StackFiles, slug: string, name: 'key_ro' | 'key_rw'): Promise<boolean> {
  try {
    return ((await files.stat('userContent', secretFile(slug, name)))?.size ?? 0) > 0;
  } catch {
    return false;
  }
}

function isLocal(values: InstanceValues): boolean {
  if (values.local === true) return true;
  return text(values.url).replace(/\/+$/, '').replace(/\/mcp$/, '') === LOCAL_URL;
}

async function readWorkspace(files: StackFiles, slug: string): Promise<TwentyWorkspace | null> {
  const values = await readValues(files, slug);
  if (!values) return null;
  // The manifest's access setting defaults to read.
  const rawAccess = text(values.access) || 'read';
  return {
    slug,
    local: isLocal(values),
    url: text(values.url),
    workspaceUrl: text(values.workspace_url),
    access: rawAccess === 'write' ? 'write' : 'read',
    skippedReason: rawAccess === 'read' || rawAccess === 'write' ? null : 'access must be read or write',
    hasReadKey: await hasSecret(files, slug, 'key_ro'),
    hasWriteKey: await hasSecret(files, slug, 'key_rw'),
  };
}

/** Reads every stored workspace. Keys are checked for presence only and never read. */
export async function listTwentyWorkspaces(files: StackFiles): Promise<TwentyWorkspace[]> {
  const workspaces = await Promise.all((await slugs(files)).map((slug) => readWorkspace(files, slug)));
  return workspaces
    .filter((w): w is TwentyWorkspace => w !== null)
    .sort((a, b) => Number(b.local) - Number(a.local) || a.slug.localeCompare(b.slug));
}

/** The local workspace's id and Twenty address, or null when it has no id. */
export async function localWorkspaceId(
  files: StackFiles,
  slug = 'main'
): Promise<{ id: string; workspaceUrl: string } | null> {
  const values = await readValues(files, slug);
  const id = values ? text(values.workspace_id) : '';
  if (!id) return null;
  return { id, workspaceUrl: text(values?.workspace_url) };
}

/** Replaces a store file in one step. A new file gets mode 600; an existing one keeps its mode. */
function writeFile(files: StackFiles, relPath: string, contents: string): Promise<void> {
  return files.writeText('userContent', relPath, contents, { mode: 0o600 });
}

const instanceText = (values: object): string => `${JSON.stringify(values, null, 2)}\n`;

/**
 * Sets the workspace's `access` setting, as `crm.sh access` does through `addon_cli configure`,
 * after the same key check. Other settings stay as they are.
 */
export async function setTwentyWorkspaceAccess(files: StackFiles, slug: string, access: TwentyAccess): Promise<void> {
  const values = ADDON_SLUG.test(slug) ? await readValues(files, slug) : null;
  if (!values) throw new Error(`crm-${slug} has no workspace in the add-on store.`);
  if (access === 'read' && !(await hasSecret(files, slug, 'key_ro'))) {
    throw new Error(`crm-${slug} has no read-only key. Connect it again with one.`);
  }
  if (access === 'write' && !(await hasSecret(files, slug, 'key_rw'))) {
    throw new Error(`crm-${slug} has no read-write key. Connect it again with one.`);
  }
  await writeFile(files, instanceFile(slug), instanceText({ ...values, access }));
}

/** True when `slug` is a valid instance slug and no workspace uses it. */
export async function twentySlugFree(files: StackFiles, slug: string): Promise<boolean> {
  return ADDON_SLUG.test(slug) && !(await files.exists('userContent', instanceFile(slug)));
}

/**
 * Writes a hosted workspace's instance file and keys in the layout `addon_store.apply_instance`
 * writes (stack v0.3.14): `instances/<slug>.json` with `url`, `access` and `local: false`, and
 * `secrets/<slug>.key_ro` and `.key_rw`, each mode 600 in folders of mode 700. Used for a
 * Circle's shared workspace, whose URL `crm.sh` can't check from this Mac (ADR 0048 §5).
 * Then sets `TWENTY_MCP_ENABLED` to 1, as `crm.sh add` does (`syncTwentyMcpFlag`).
 */
export async function writeTwentyWorkspace(
  files: StackFiles,
  slug: string,
  values: { url: string; access: TwentyAccess },
  keys: { ro: string; rw: string }
): Promise<void> {
  if (!ADDON_SLUG.test(slug)) throw new Error(`${slug} isn’t a workspace name the stack accepts.`);
  for (const sub of ['instances', 'secrets']) await files.mkdir('userContent', `${TWENTY_STORE}/${sub}`, { mode: 0o700 });
  await writeFile(files, secretFile(slug, 'key_ro'), keys.ro);
  await writeFile(files, secretFile(slug, 'key_rw'), keys.rw);
  await writeFile(files, instanceFile(slug), instanceText({ url: values.url, access: values.access, local: false }));
  await syncTwentyMcpFlag(files);
}

/** Sets a stored workspace's URL, keeping its other settings. */
export async function setTwentyWorkspaceUrl(files: StackFiles, slug: string, url: string): Promise<void> {
  const values = ADDON_SLUG.test(slug) ? await readValues(files, slug) : null;
  if (!values) throw new Error(`crm-${slug} has no workspace in the add-on store.`);
  await writeFile(files, instanceFile(slug), instanceText({ ...values, url }));
}

/**
 * Deletes a workspace's instance file and keys, as `addon_store.remove_instance` does, then
 * sets `TWENTY_MCP_ENABLED` for what is left (`syncTwentyMcpFlag`).
 */
export async function removeTwentyWorkspace(files: StackFiles, slug: string): Promise<void> {
  if (!ADDON_SLUG.test(slug)) return;
  await files.remove('userContent', instanceFile(slug));
  for (const name of ['key_ro', 'key_rw'] as const) await files.remove('userContent', secretFile(slug, name));
  await syncTwentyMcpFlag(files);
}

/** True when a hosted workspace is stored, so the bootstraps would register it. */
export async function hasActiveHostedWorkspaces(files: StackFiles): Promise<boolean> {
  for (const slug of await slugs(files)) {
    const values = await readValues(files, slug);
    if (values && !isLocal(values)) return true;
  }
  return false;
}

/**
 * Sets `TWENTY_MCP_ENABLED` in the stack's `.env` to what `twentyFlags` gives for the store and
 * `.env`'s own `TWENTY_LOCAL_ENABLED`: 1 while this Mac's Twenty is on or a hosted workspace is
 * stored, else 0. The bootstraps read it from `.env` (compose's `${TWENTY_MCP_ENABLED:-0}`), so a
 * workspace added or removed without `crm.sh`, or removed with it (`crm.sh remove` leaves the
 * flag), needs this before the next reload. Nothing happens when the stack has no `.env`.
 */
export async function syncTwentyMcpFlag(files: StackFiles): Promise<void> {
  const before = await files.readText('stack', '.env');
  if (before === null) return;
  const local = parseEnv(before).TWENTY_LOCAL_ENABLED === '1';
  const value = local || (await hasActiveHostedWorkspaces(files)) ? '1' : '0';
  const after = upsertEnvLines(before, { TWENTY_MCP_ENABLED: value });
  if (after !== before) await files.writeText('stack', '.env', after);
}
