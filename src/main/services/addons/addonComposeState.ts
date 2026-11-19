import { BOUNDARY_ASSISTANT_COMPOSE_PROFILES, buildComposeProfileArgs } from '../../../shared/assistantStackConstants';
import type { AddonCatalogEntry, AddonId } from '../../../shared/types/addons';
import { getInstalledAddons, setAddonInstalled } from '../assistant/AssistantStackStore';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { actualAvailable, readActualFlags } from './actualAddon';
import { bitwardenOffered, readBitwardenEnabled } from './bitwardenAddon';
import { emailAvailable, readEmailFlags } from './emailAddon';
import { readVikunjaEnabled, vikunjaAvailable } from './vikunjaAddon';
import { BUILTIN_ADDON_IDS, builtinAddonAvailable, readBuiltinEnabled } from './builtinAddons';
import { BITWARDEN_ENTRY, LIGHTRAG_ENTRY, N8N_ENTRY, TWENTY_ENTRY, VIKUNJA_ENTRY } from './addonCatalog';
import { hasActiveHostedWorkspaces, twentyWorkspacesDir } from './twentyWorkspaces';

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
export function installedAddonsHere(): AddonId[] {
  const { root } = tryResolveAssistantRoot();
  return root ? installedAddonsAt(root) : [];
}

/** `installedAddonsHere` for a root the caller already resolved, such as the store's listing. */
export function installedAddonsAt(root: string): AddonId[] {
  const ids: AddonId[] = getInstalledAddons(root).filter(
    (id) => id !== 'actual' && id !== 'bitwarden' && id !== 'email' && id !== 'vikunja' && id !== 'n8n' && id !== 'lightrag'
  );
  if (actualAvailable(root) && readActualFlags(root).local) ids.push('actual');
  if (bitwardenOffered(root) && readBitwardenEnabled(root)) ids.push('bitwarden');
  if (emailAvailable(root) && readEmailFlags(root).enabled) ids.push('email');
  if (vikunjaAvailable(root) && readVikunjaEnabled(root)) ids.push('vikunja');
  for (const id of BUILTIN_ADDON_IDS) if (builtinAddonAvailable(root, id) && readBuiltinEnabled(root, id)) ids.push(id);
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
export function addonComposeProfiles(): string[] {
  const profiles = installedAddonsHere().flatMap((id) => {
    const entry = ENTRIES[id];
    return entry && !(BOUNDARY_ASSISTANT_COMPOSE_PROFILES as readonly string[]).includes(entry.profile) ? [entry.profile] : [];
  });
  const { root } = tryResolveAssistantRoot();
  if (root && actualAvailable(root)) {
    const flags = readActualFlags(root);
    if (flags.enabled) profiles.push('budget');
    if (flags.local) profiles.push('budget-local');
  }
  if (root && emailAvailable(root)) {
    const flags = readEmailFlags(root);
    if (flags.enabled) profiles.push('email');
    if (flags.enabled && flags.drafts) profiles.push('email-drafts');
  }
  return profiles;
}

/**
 * Twenty's two flags. `TWENTY_LOCAL_ENABLED` starts this Mac's Twenty and follows the installed
 * record, and the bootstraps register the local workspace only while it is 1.
 * `TWENTY_MCP_ENABLED` makes them register a `crm-<slug>` per stored workspace; at 0 they remove
 * every `crm-*` entry, so it stays 1 while a hosted workspace is stored even with this Mac's
 * Twenty off.
 */
export function twentyFlags(
  installed: boolean,
  dir: string
): { TWENTY_LOCAL_ENABLED: '0' | '1'; TWENTY_MCP_ENABLED: '0' | '1' } {
  return {
    TWENTY_LOCAL_ENABLED: installed ? '1' : '0',
    TWENTY_MCP_ENABLED: installed || hasActiveHostedWorkspaces(dir) ? '1' : '0',
  };
}

/** Every add-on flag for the stack root this session resolves. Both off while none resolves. */
export function addonComposeEnv(): Record<string, string> {
  const { root } = tryResolveAssistantRoot();
  if (!root) return { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' };
  return twentyFlags(getInstalledAddons(root).includes('twenty'), twentyWorkspacesDir(root));
}

/**
 * `--profile` args for every compose call Boundary makes. The calendar profile reaches the stack
 * through COMPOSE_PROFILES only, not through these args.
 */
export function boundaryComposeProfileArgs(): string[] {
  return buildComposeProfileArgs([...BOUNDARY_ASSISTANT_COMPOSE_PROFILES, ...addonComposeProfiles()]);
}
