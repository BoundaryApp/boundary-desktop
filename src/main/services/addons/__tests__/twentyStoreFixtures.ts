import fs from 'node:fs';
import path from 'node:path';
import { resolveAssistantUserContentRoot } from '../../assistant/assistantPaths';
import { TWENTY_STORE } from '../twentyWorkspaces';

/**
 * Twenty workspaces in the add-on store as `crm.sh` writes them (stack v0.3.13):
 * `instances/<slug>.json` holds the settings, `secrets/<slug>.key_ro` and `.key_rw` the keys.
 * A local workspace points at the stack's own twenty-server; a hosted one at a Twenty elsewhere.
 */

/** The store's folder on disk for the stack in `root`. */
export function twentyWorkspacesDir(root: string): string {
  return path.join(resolveAssistantUserContentRoot(root), TWENTY_STORE);
}

export interface TwentyStoreSettings {
  url?: string;
  access?: string;
  local?: boolean;
  workspace_url?: string;
  workspace_id?: string;
}

/** This Mac's workspace. */
export const LOCAL_SETTINGS: TwentyStoreSettings = { url: 'http://twenty-server:3000', local: true };

/** A hosted workspace. */
export const HOSTED_SETTINGS: TwentyStoreSettings = { url: 'https://crm.example.com', local: false };

/** A hosted workspace on twenty.com. */
export const WORK_SETTINGS: TwentyStoreSettings = { url: 'https://work.twenty.com', local: false };

/** This Mac's workspace after crm.sh init, which records the workspace's browser URL and id. */
export function signedInLocalSettings(id = 'ws-1', url = 'http://localhost:3000/'): TwentyStoreSettings {
  return { ...LOCAL_SETTINGS, workspace_url: url, workspace_id: id };
}

/** Writes one workspace's settings file and any keys given; returns the settings file's path. */
export function writeTwentyWorkspace(
  storeDir: string,
  slug: string,
  settings: TwentyStoreSettings,
  keys: { keyRo?: string; keyRw?: string } = {},
): string {
  fs.mkdirSync(path.join(storeDir, 'instances'), { recursive: true });
  const file = path.join(storeDir, 'instances', `${slug}.json`);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  for (const [name, value] of [
    ['key_ro', keys.keyRo],
    ['key_rw', keys.keyRw],
  ] as const) {
    if (value === undefined) continue;
    fs.mkdirSync(path.join(storeDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'secrets', `${slug}.${name}`), value, { mode: 0o600 });
  }
  return file;
}

/** Parses a stored workspace's settings file. */
export function readTwentyWorkspace(storeDir: string, slug: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(storeDir, 'instances', `${slug}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}
