import { ipcMain } from 'electron';
import type {
  BoundaryBrowserUpdateResult,
  HostBridgeApprovalRespondPayload,
  HostBridgeBrowserSettings,
} from '../../../shared/types/hostBridge';
import { applyHostBridgeBrowserToHermes } from '../assistant/AssistantStackService';
import { listPendingHostBridgeApprovals, respondToHostBridgeApproval } from './approvals';
import {
  getBoundaryBrowserState,
  getHostToolsState,
  openBoundaryBrowser,
  updateBoundaryBrowserSettings,
} from './hostBridgeService';
import { listHostBridgeGrants, revokeAllHostBridgeGrants, revokeHostBridgeGrant } from './hostBridgeStore';

export function registerHostBridgeHandlers(): void {
  ipcMain.handle('host-bridge:approval-respond', async (_event, payload: HostBridgeApprovalRespondPayload) => {
    const ok = respondToHostBridgeApproval(payload.id, payload.choice);
    return ok ? { success: true } : { success: false, error: 'That approval is no longer pending.' };
  });

  ipcMain.handle('host-bridge:approvals-pending', async () => listPendingHostBridgeApprovals());

  ipcMain.handle('host-bridge:tools-state', async () => getHostToolsState());

  ipcMain.handle('host-bridge:browser-state', async () => getBoundaryBrowserState());

  // Saves the settings, applies them to the bridge, then points Hermes at (or away from) the
  // browser. Hermes reads browser.cdp_url on every call, so no restart.
  ipcMain.handle(
    'host-bridge:browser-update',
    async (_event, settings: HostBridgeBrowserSettings): Promise<BoundaryBrowserUpdateResult> => {
      await updateBoundaryBrowserSettings(settings);
      const hermes = await applyHostBridgeBrowserToHermes();
      return { state: await getBoundaryBrowserState(), hermesError: hermes.success ? undefined : hermes.error };
    }
  );

  ipcMain.handle('host-bridge:grants-list', async () => listHostBridgeGrants());

  ipcMain.handle('host-bridge:grant-revoke', async (_event, grant: { capability: string; resource: string }) => {
    revokeHostBridgeGrant(grant.capability, grant.resource);
    return listHostBridgeGrants();
  });

  ipcMain.handle('host-bridge:grants-revoke-all', async () => {
    revokeAllHostBridgeGrants();
    return listHostBridgeGrants();
  });

  ipcMain.handle('host-bridge:browser-open', async () => {
    try {
      await openBoundaryBrowser();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
