import type { AddonCatalogEntry, AddonId } from '../../../shared/types/addons';
import { ACTUAL_ENTRY, BITWARDEN_ENTRY, EMAIL_ENTRY, LIGHTRAG_ENTRY, N8N_ENTRY, TWENTY_ENTRY, VIKUNJA_ENTRY } from './addonCatalog';
import { installedAddonsHere } from './addonComposeState';
import { pendingReservationsMiB } from './engineMakeRoom';

const ADDON_ENTRIES: Record<AddonId, AddonCatalogEntry> = {
  twenty: TWENTY_ENTRY,
  actual: ACTUAL_ENTRY,
  bitwarden: BITWARDEN_ENTRY,
  email: EMAIL_ENTRY,
  vikunja: VIKUNJA_ENTRY,
  n8n: N8N_ENTRY,
  lightrag: LIGHTRAG_ENTRY,
};

/**
 * Memory reserved by each installed add-on that is turned on (n8n and LightRAG among them), and
 * by each add-on being installed that asked for room, in MiB.
 */
export async function engineReservationsMiB(
  deps: {
    addons?: () => Promise<AddonId[]>;
    pending?: () => Record<string, number>;
  } = {}
): Promise<Record<string, number>> {
  const reserved: Record<string, number> = {};
  for (const id of await (deps.addons ?? installedAddonsHere)()) {
    const entry = ADDON_ENTRIES[id];
    if (entry) reserved[id] = entry.reserveMiB;
  }
  // Add-ons being installed that asked for room (ADR 0055 §3).
  return { ...(deps.pending ?? pendingReservationsMiB)(), ...reserved };
}
