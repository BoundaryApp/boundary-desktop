import {
  BOUNDARY_ASSISTANT_COMPOSE_PROFILES,
  LIGHTRAG_COMPOSE_PROFILE,
  buildComposeProfileArgs,
} from '../../../shared/assistantStackConstants';
import type { AddonCatalogEntry, AddonId } from '../../../shared/types/addons';
import { getInstalledAddons, isLightragEnabled, setAddonInstalled } from '../assistant/AssistantStackStore';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { TWENTY_ENTRY } from './addonCatalog';

/** Entry per add-on id, for profiles and flags. Installed state comes from the store only. */
const ENTRIES: Record<AddonId, AddonCatalogEntry> = { twenty: TWENTY_ENTRY };

/**
 * Installed add-ons of the stack root this session resolves (the listing resolves the same
 * one). None while no root resolves. The store leaves out ids this build doesn't know.
 */
export function installedAddonsHere(): AddonId[] {
  const { root } = tryResolveAssistantRoot();
  return root ? getInstalledAddons(root) : [];
}

/** Records `id` as installed or off for the stack root this session resolves. */
export function setAddonInstalledHere(id: AddonId, installed: boolean): void {
  const { root, error } = tryResolveAssistantRoot();
  if (!root) throw new Error(error ?? 'The agent stack folder could not be found.');
  setAddonInstalled(root, id, installed);
}

/** Compose profiles of the installed add-ons. */
export function addonComposeProfiles(): string[] {
  return installedAddonsHere().map((id) => ENTRIES[id].profile);
}

/** Every add-on flag: '1' while its add-on is installed, '0' otherwise. */
export function addonComposeEnv(): Record<string, string> {
  const installed = new Set(installedAddonsHere());
  const env: Record<string, string> = {};
  for (const entry of Object.values(ENTRIES)) {
    for (const flag of entry.flags) env[flag] = installed.has(entry.id) ? '1' : '0';
  }
  return env;
}

/** `rag` while LightRAG is on (Services → LightRAG), otherwise none. */
export function lightragComposeProfiles(): string[] {
  return isLightragEnabled() ? [LIGHTRAG_COMPOSE_PROFILE] : [];
}

/**
 * The flag the Hermes bootstraps read to register LightRAG's MCP server. It overrides the one
 * in the stack's `.env`, which setup.sh set to 1 on installs from Boundaries that passed --rag.
 */
export function lightragComposeEnv(): Record<string, string> {
  return { LIGHTRAG_MCP_ENABLED: isLightragEnabled() ? '1' : '0' };
}

/**
 * `--profile` args for every compose call Boundary makes. The calendar profile reaches the stack
 * through COMPOSE_PROFILES only, not through these args.
 */
export function boundaryComposeProfileArgs(): string[] {
  return buildComposeProfileArgs([
    ...BOUNDARY_ASSISTANT_COMPOSE_PROFILES,
    ...lightragComposeProfiles(),
    ...addonComposeProfiles(),
  ]);
}
