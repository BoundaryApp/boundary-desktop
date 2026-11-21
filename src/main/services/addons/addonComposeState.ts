import { BOUNDARY_ASSISTANT_COMPOSE_PROFILES, buildComposeProfileArgs } from '../../../shared/assistantStackConstants';
import type { AddonCatalogEntry, AddonId } from '../../../shared/types/addons';
import { getInstalledAddons, setAddonInstalled } from '../assistant/AssistantStackStore';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { stackFilesAt } from '../stackHost/activeStack';
import type { StackFiles } from '../stackHost/types';
import { actualAvailable, readActualFlags } from './actualAddon';
import { bitwardenOffered, readBitwardenEnabled } from './bitwardenAddon';
import { emailAvailable, readEmailFlags } from './emailAddon';
import { readVikunjaEnabled, vikunjaAvailable } from './vikunjaAddon';
import { BUILTIN_ADDON_IDS, builtinAddonAvailable, readBuiltinEnabled } from './builtinAddons';
import { BITWARDEN_ENTRY, LIGHTRAG_ENTRY, N8N_ENTRY, TWENTY_ENTRY, VIKUNJA_ENTRY } from './addonCatalog';
import { hasActiveHostedWorkspaces } from './twentyWorkspaces';
import { moveFlagsToEnv, type EnvMoveRecord } from './envFlagMove';

/** Entry per add-on id whose compose profile follows its installed state. */
const ENTRIES: Partial<Record<AddonId, AddonCatalogEntry>> = {
  twenty: TWENTY_ENTRY,
  bitwarden: BITWARDEN_ENTRY,
  vikunja: VIKUNJA_ENTRY,
  n8n: N8N_ENTRY,
  lightrag: LIGHTRAG_ENTRY,
};

/**
 * Installed add-ons of the stack root this session resolves (the listing resolves the same
 * one). None while no root resolves. Twenty comes from Boundary's store; Actual and Bitwarden from
 * the stack's `.env`, which `addon.sh` writes (spec decision 14): Actual is installed while this
 * Mac's server is on, Bitwarden while `BITWARDEN_ENABLED` is 1, email while `EMAIL_ENABLED` is 1, Todo lists while
 * `VIKUNJA_MCP_ENABLED` is 1, n8n while `AUTOMATION_ENABLED` is 1 and LightRAG while
 * `LIGHTRAG_MCP_ENABLED` is 1.
 */
export async function installedAddonsHere(): Promise<AddonId[]> {
  const { root } = tryResolveAssistantRoot();
  return root ? installedAddonsAt(root) : [];
}

/** `installedAddonsHere` for a root the caller already resolved, such as the store's listing. */
export async function installedAddonsAt(root: string, files: StackFiles = stackFilesAt(root)): Promise<AddonId[]> {
  const ids: AddonId[] = getInstalledAddons(root).filter(
    (id) => id !== 'actual' && id !== 'bitwarden' && id !== 'email' && id !== 'vikunja' && id !== 'n8n' && id !== 'lightrag'
  );
  if ((await actualAvailable(files)) && (await readActualFlags(files)).local) ids.push('actual');
  if ((await bitwardenOffered(files)) && (await readBitwardenEnabled(files))) ids.push('bitwarden');
  if ((await emailAvailable(files)) && (await readEmailFlags(files)).enabled) ids.push('email');
  if ((await vikunjaAvailable(files)) && (await readVikunjaEnabled(files))) ids.push('vikunja');
  for (const id of BUILTIN_ADDON_IDS) {
    if ((await builtinAddonAvailable(files, id)) && (await readBuiltinEnabled(files, id))) ids.push(id);
  }
  return ids;
}

/** Records `id` as installed or off for the stack root this session resolves. */
export function setAddonInstalledHere(id: AddonId, installed: boolean): void {
  const { root, error } = tryResolveAssistantRoot();
  if (!root) throw new Error(error ?? 'The agent stack folder could not be found.');
  setAddonInstalled(root, id, installed);
}

/**
 * Compose profiles of the installed add-ons. Actual's follow its two flags in the stack's
 * `.env`: `budget` (the MCP containers) while connected budgets get tools, `budget-local` while
 * this Mac's server runs. Bitwarden's `bitwarden` (the broker) follows `BITWARDEN_ENABLED`, Todo lists' `todo` follows
 * `VIKUNJA_MCP_ENABLED` and LightRAG's `rag` follows `LIGHTRAG_MCP_ENABLED`. n8n's `automation` is
 * always one of Boundary's profiles, so it isn't repeated here.
 * Boundary's COMPOSE_PROFILES replaces the one `addon.sh` syncs into
 * `.env`, so the managed stack needs them here.
 */
export async function addonComposeProfiles(): Promise<string[]> {
  const { root } = tryResolveAssistantRoot();
  if (!root) return [];
  const files = stackFilesAt(root);
  const profiles = (await installedAddonsAt(root, files)).flatMap((id) => {
    const entry = ENTRIES[id];
    return entry && !(BOUNDARY_ASSISTANT_COMPOSE_PROFILES as readonly string[]).includes(entry.profile) ? [entry.profile] : [];
  });
  if (await actualAvailable(files)) {
    const flags = await readActualFlags(files);
    if (flags.enabled) profiles.push('budget');
    if (flags.local) profiles.push('budget-local');
  }
  if (await emailAvailable(files)) {
    const flags = await readEmailFlags(files);
    if (flags.enabled) profiles.push('email');
    if (flags.enabled && flags.drafts) profiles.push('email-drafts');
  }
  return profiles;
}

/**
 * Twenty's two flags as they follow the installed record and the store, for the one-time move
 * into `.env`. `TWENTY_LOCAL_ENABLED` starts this Mac's Twenty, and the bootstraps register the
 * local workspace only while it is 1. `TWENTY_MCP_ENABLED` makes them register a `crm-<slug>` per
 * stored workspace; at 0 they remove every `crm-*` entry, so it stays 1 while a hosted workspace
 * is stored even with this Mac's Twenty off. The installer leaves the same values through
 * `addon.sh` (addonInstaller.ts).
 */
export async function twentyFlags(
  installed: boolean,
  files: StackFiles
): Promise<{ TWENTY_LOCAL_ENABLED: '0' | '1'; TWENTY_MCP_ENABLED: '0' | '1' }> {
  return {
    TWENTY_LOCAL_ENABLED: installed ? '1' : '0',
    TWENTY_MCP_ENABLED: installed || (await hasActiveHostedWorkspaces(files)) ? '1' : '0',
  };
}

export interface MoveTwentyFlagsDeps extends EnvMoveRecord {
  /** Twenty is in Boundary's installed list for `root`. */
  installed(root: string): boolean;
}

/**
 * Writes Twenty's flags into the managed stack's `.env`, once per stack root, with the values
 * Boundary passed to every compose call before `.env` became their only source. After the move,
 * a flag missing from `.env` (a stack folder set up again) is written the same way, so compose's
 * `${TWENTY_*:-0}` default never turns off a Twenty that is installed. Doesn't run the profile
 * sync: Boundary's compose calls pass COMPOSE_PROFILES, and the next install, Start or Turn off
 * syncs it. Returns the flags it wrote; none when there's no `.env`, in which case nothing is
 * marked and it runs again at the next start.
 */
export function moveTwentyFlagsToEnv(
  files: StackFiles,
  root: string,
  deps: MoveTwentyFlagsDeps
): Promise<Record<string, string>> {
  return moveFlagsToEnv(files, root, deps, async (moved, current) => {
    const flags = await twentyFlags(deps.installed(root), files);
    return Object.fromEntries(Object.entries(flags).filter(([flag]) => !moved || !(flag in current)));
  });
}

/**
 * `--profile` args for every compose call Boundary makes. The calendar profile reaches the stack
 * through COMPOSE_PROFILES only, not through these args.
 */
export async function boundaryComposeProfileArgs(): Promise<string[]> {
  return buildComposeProfileArgs([...BOUNDARY_ASSISTANT_COMPOSE_PROFILES, ...(await addonComposeProfiles())]);
}
