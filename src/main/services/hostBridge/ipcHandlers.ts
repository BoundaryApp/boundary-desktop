import { handle, handleResult } from '../../ipc';
import type {
  BoundaryBrowserUpdateResult,
  HostBridgeApprovalRespondPayload,
  HostBridgeBrowserSettings,
} from '../../../shared/types/hostBridge';
import {
  applyHostBridgeBrowserToHermes,
  applyLlmConnectionToHermes,
  isAssistantStackReady,
} from '../assistant/AssistantStackService';
import { listPendingHostBridgeApprovals, respondToHostBridgeApproval } from './approvals';
import {
  getBoundaryBrowserState,
  getHostBridgeAgentState,
  getHostToolsState,
  openBoundaryBrowser,
  resumeHostBridgeAgent,
  rotateHostBridgeAgentTokens,
  stopHostBridgeAgent,
  type ProvisionHermes,
  updateBoundaryBrowserSettings,
} from './hostBridgeService';
import { listHostBridgeGrants, revokeAllHostBridgeGrants, revokeHostBridgeGrant } from './hostBridgeStore';

/**
 * New bridge tokens reach Hermes through the stack's one apply path. A stopped stack is skipped:
 * its next start runs the apply.
 */
const provisionHermes: ProvisionHermes = async () =>
  (await isAssistantStackReady()) ? applyLlmConnectionToHermes() : { success: true };

export function registerHostBridgeHandlers(): void {
  handleResult('host-bridge:approval-respond', async (_event, payload: HostBridgeApprovalRespondPayload) => {
    const ok = respondToHostBridgeApproval(payload.id, payload.choice);
    return ok ? { success: true } : { success: false, error: 'That approval is no longer pending.' };
  });

  handle('host-bridge:approvals-pending', async () => listPendingHostBridgeApprovals());

  handle('host-bridge:tools-state', async () => getHostToolsState());

  handle('host-bridge:browser-state', async () => getBoundaryBrowserState());

  // Saves the settings, applies them to the bridge, then points Hermes at (or away from) the
  // browser. Hermes reads browser.cdp_url on every call, so no restart.
  handle(
    'host-bridge:browser-update',
    async (_event, settings: HostBridgeBrowserSettings): Promise<BoundaryBrowserUpdateResult> => {
      await updateBoundaryBrowserSettings(settings);
      const hermes = await applyHostBridgeBrowserToHermes();
      return { state: await getBoundaryBrowserState(), hermesError: hermes.success ? undefined : hermes.error };
    }
  );

  handle('host-bridge:grants-list', async () => listHostBridgeGrants());

  handle('host-bridge:grant-revoke', async (_event, grant: { capability: string; resource: string }) => {
    revokeHostBridgeGrant(grant.capability, grant.resource);
    return listHostBridgeGrants();
  });

  handle('host-bridge:grants-revoke-all', async () => {
    revokeAllHostBridgeGrants();
    return listHostBridgeGrants();
  });

  // Stop agent (ADR 0027 §7): no argument reads the state; true stops, false turns access back on.
  handle('host-bridge:agent-stopped', async (_event, stopped?: boolean) => {
    if (stopped === undefined) return getHostBridgeAgentState();
    return stopped ? stopHostBridgeAgent(provisionHermes) : resumeHostBridgeAgent(provisionHermes);
  });

  handleResult('host-bridge:rotate-tokens', async () => rotateHostBridgeAgentTokens(provisionHermes));

  handleResult('host-bridge:browser-open', async () => {
    await openBoundaryBrowser();
    return { success: true };
  });
}
