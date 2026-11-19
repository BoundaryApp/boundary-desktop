import fs from 'node:fs';
import path from 'node:path';
import type { TwentyAccess, TwentyWorkspace } from '../../../shared/types/addons';
import { ADDON_SLUG } from '../../../shared/utils/slug';
import { resolveAssistantUserContentRoot } from '../assistant/assistantPaths';

const LOCAL_URL = 'http://twenty-server:3000';

/**
 * The Twenty add-on's store (stack v0.3.13): `instances/<slug>.json` holds a workspace's
 * settings, `secrets/<slug>.key_ro` and `.key_rw` its API keys. It sits under
 * `ASSISTANT_DATA_ROOT`, where `crm.sh` writes it and the Hermes bootstraps mount it.
 */
export function twentyWorkspacesDir(root: string): string {
  return path.join(resolveAssistantUserContentRoot(root), 'addons', 'twenty');
}

interface InstanceValues {
  url?: unknown;
  access?: unknown;
  local?: unknown;
  workspace_url?: unknown;
  workspace_id?: unknown;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function slugs(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(dir, 'instances'));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((slug) => ADDON_SLUG.test(slug));
}

function readValues(dir: string, slug: string): InstanceValues | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'instances', `${slug}.json`), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as InstanceValues) : null;
  } catch {
    return null;
  }
}

/** The store counts a secret as set when its file is non-empty (`addon_store._secret_set`). */
function hasSecret(dir: string, slug: string, name: 'key_ro' | 'key_rw'): boolean {
  try {
    return fs.statSync(path.join(dir, 'secrets', `${slug}.${name}`)).size > 0;
  } catch {
    return false;
  }
}

function isLocal(values: InstanceValues): boolean {
  if (values.local === true) return true;
  return text(values.url).replace(/\/+$/, '').replace(/\/mcp$/, '') === LOCAL_URL;
}

function readWorkspace(dir: string, slug: string): TwentyWorkspace | null {
  const values = readValues(dir, slug);
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
    hasReadKey: hasSecret(dir, slug, 'key_ro'),
    hasWriteKey: hasSecret(dir, slug, 'key_rw'),
    parked: false,
  };
}

/** Reads every stored workspace. Keys are checked for presence only and never read. */
export function listTwentyWorkspaces(dir: string): TwentyWorkspace[] {
  return slugs(dir)
    .map((slug) => readWorkspace(dir, slug))
    .filter((w): w is TwentyWorkspace => w !== null)
    .sort((a, b) => Number(b.local) - Number(a.local) || a.slug.localeCompare(b.slug));
}

/** The local workspace's id and Twenty address, or null when it has no id. */
export function localWorkspaceId(
  dir: string,
  slug = 'main',
): { id: string; workspaceUrl: string } | null {
  const values = readValues(dir, slug);
  const id = values ? text(values.workspace_id) : '';
  if (!id) return null;
  return { id, workspaceUrl: text(values?.workspace_url) };
}

function writeAtomic(file: string, contents: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Sets the workspace's `access` setting, as `crm.sh access` does through `addon_cli configure`,
 * after the same key check. Other settings stay as they are.
 */
export function setTwentyWorkspaceAccess(dir: string, slug: string, access: TwentyAccess): void {
  const values = ADDON_SLUG.test(slug) ? readValues(dir, slug) : null;
  if (!values) throw new Error(`crm-${slug} has no workspace in the add-on store.`);
  if (access === 'read' && !hasSecret(dir, slug, 'key_ro')) {
    throw new Error(`crm-${slug} has no read-only key. Connect it again with one.`);
  }
  if (access === 'write' && !hasSecret(dir, slug, 'key_rw')) {
    throw new Error(`crm-${slug} has no read-write key. Connect it again with one.`);
  }
  writeAtomic(path.join(dir, 'instances', `${slug}.json`), `${JSON.stringify({ ...values, access }, null, 2)}\n`);
}

/** True when `slug` is a valid instance slug and no workspace uses it. */
export function twentySlugFree(dir: string, slug: string): boolean {
  return ADDON_SLUG.test(slug) && !fs.existsSync(path.join(dir, 'instances', `${slug}.json`));
}

/**
 * Writes a hosted workspace's instance file and keys in the layout `addon_store.apply_instance`
 * writes (stack v0.3.14): `instances/<slug>.json` with `url`, `access` and `local: false`, and
 * `secrets/<slug>.key_ro` and `.key_rw`, each mode 600 in folders of mode 700. Used for a
 * Circle's shared workspace, whose URL `crm.sh` can't check from this Mac (ADR 0048 §5).
 */
export function writeTwentyWorkspace(
  dir: string,
  slug: string,
  values: { url: string; access: TwentyAccess },
  keys: { ro: string; rw: string }
): void {
  if (!ADDON_SLUG.test(slug)) throw new Error(`${slug} isn’t a workspace name the stack accepts.`);
  for (const sub of ['instances', 'secrets']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dir, 'secrets', `${slug}.key_ro`), keys.ro);
  writeAtomic(path.join(dir, 'secrets', `${slug}.key_rw`), keys.rw);
  writeAtomic(
    path.join(dir, 'instances', `${slug}.json`),
    `${JSON.stringify({ url: values.url, access: values.access, local: false }, null, 2)}\n`
  );
}

/** Sets a stored workspace's URL, keeping its other settings. */
export function setTwentyWorkspaceUrl(dir: string, slug: string, url: string): void {
  const values = ADDON_SLUG.test(slug) ? readValues(dir, slug) : null;
  if (!values) throw new Error(`crm-${slug} has no workspace in the add-on store.`);
  writeAtomic(path.join(dir, 'instances', `${slug}.json`), `${JSON.stringify({ ...values, url }, null, 2)}\n`);
}

/** Deletes a workspace's instance file and keys, as `addon_store.remove_instance` does. */
export function removeTwentyWorkspace(dir: string, slug: string): void {
  if (!ADDON_SLUG.test(slug)) return;
  fs.rmSync(path.join(dir, 'instances', `${slug}.json`), { force: true });
  for (const name of ['key_ro', 'key_rw']) fs.rmSync(path.join(dir, 'secrets', `${slug}.${name}`), { force: true });
}

/** True when a hosted workspace is stored, so the bootstraps would register it. */
export function hasActiveHostedWorkspaces(dir: string): boolean {
  return listTwentyWorkspaces(dir).some((w) => !w.local);
}
