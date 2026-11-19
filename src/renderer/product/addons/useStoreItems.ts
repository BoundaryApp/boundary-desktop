import { ASSISTANT_UI_SERVICES, buildServiceUrl } from '../../../shared/assistantUiServices';
import type { AssistantStackStatus } from '../../../shared/types/assistantStack';
import type { AddonListing } from '../../../shared/types/addons';
import { addonStoreItem, type StoreItem } from './storeItems';
import { useAddonListings, useAnyAddonInstall } from './useAddons';
import { useTwentyWorkspaces } from './useTwenty';
import { useActualOverview } from './useActual';
import { useBitwardenOverview } from './useBitwarden';
import { useEmailOverview } from './useEmail';

/** Every store entry, in catalog order. */
export function useStoreItems(): { items: StoreItem[]; listings: AddonListing[] } {
  const listings = useAddonListings() ?? [];
  const install = useAnyAddonInstall();
  const workspaces = useTwentyWorkspaces();
  const actual = useActualOverview();
  const bitwarden = useBitwardenOverview();
  const email = useEmailOverview();
  const items = listings.map((l) => addonStoreItem(l, install?.id === l.entry.id ? install : null, workspaces, actual, bitwarden, email));
  return { items, listings };
}

/** Where n8n or LightRAG opens: n8n's editor, LightRAG's WebUI and then Neo4j's browser. */
export function builtinOpens(id: 'n8n' | 'lightrag', status: AssistantStackStatus): { title: string; url: string }[] {
  const ids = id === 'n8n' ? ['n8n'] : ['lightrag', 'neo4j'];
  return ASSISTANT_UI_SERVICES.filter((s) => ids.includes(s.id)).map((d) => ({
    title: d.title,
    url: buildServiceUrl(status.ports, d.portKey, d.path),
  }));
}

/**
 * Opens n8n's editor, or LightRAG's WebUI (`which` 0) or Neo4j's browser (1), on the ports Boundary
 * assigned. Resolves to a line to show, or null.
 */
export async function openBuiltinAddon(id: 'n8n' | 'lightrag', name: string, which = 0): Promise<string | null> {
  let status: AssistantStackStatus;
  try {
    status = await window.electronAPI.assistantStack.getStatus();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const target = builtinOpens(id, status)[which];
  return target ? openServiceUrl(target.url, name) : `Couldn’t find where ${name} runs.`;
}

/** Opens a service in the browser; resolves to a line to show, or null. */
export async function openServiceUrl(url: string, name: string): Promise<string | null> {
  try {
    const result = await window.electronAPI.urls.openUrl(url);
    return result.success ? null : `Couldn’t open ${name}.`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
