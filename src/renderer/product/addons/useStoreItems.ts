import type { AssistantStackStatus } from '../../../shared/types/assistantStack';
import type { AddonListing } from '../../../shared/types/addons';
import { errorText } from '../../components/ui/use-sheet-action';
import { addonStoreItem, type StoreItem } from './storeItems';
import { lineFromIpc } from './addonPageActions';
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
  return status.addonServices.filter((s) => ids.includes(s.id)).map((s) => ({ title: s.title, url: s.url }));
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
    return errorText(e);
  }
  const target = builtinOpens(id, status)[which];
  return target ? openServiceUrl(target.url, name) : `Couldn’t find where ${name} runs.`;
}

/** Opens a service in the browser; resolves to a line to show, or null. */
export function openServiceUrl(url: string, name: string): Promise<string | null> {
  // The browser's own error isn't shown: the line names the service.
  return lineFromIpc(() => window.electronAPI.urls.openUrl(url).then((r) => ({ success: r.success })), `Couldn’t open ${name}.`);
}
