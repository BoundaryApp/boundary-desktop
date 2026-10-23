import type {
  BoundaryBrowserState,
  BoundaryBrowserUpdateResult,
  HostBridgeApprovalEvent,
  HostBridgeApprovalRespondPayload,
  HostBridgeBrowserSettings,
  HostBridgeGrant,
  HostToolsState,
} from '../../shared/types/hostBridge';

function api() {
  return window.electronAPI.hostBridge;
}

/** Host bridge (ADR 0027): approvals Boundary raises for host tools Hermes calls. */
export const hostBridgeIPC = {
  onApproval(callback: (event: HostBridgeApprovalEvent) => void): () => void {
    return api().onApproval(callback);
  },

  onApprovalCleared(callback: (event: { id: string }) => void): () => void {
    return api().onApprovalCleared(callback);
  },

  respondApproval(payload: HostBridgeApprovalRespondPayload): Promise<{ success: boolean; error?: string }> {
    return api().respondApproval(payload);
  },

  listPendingApprovals(): Promise<HostBridgeApprovalEvent[]> {
    return api().listPendingApprovals();
  },

  getToolsState(): Promise<HostToolsState> {
    return api().getToolsState();
  },

  onToolsState(callback: (state: HostToolsState) => void): () => void {
    return api().onToolsState(callback);
  },

  getBrowserState(): Promise<BoundaryBrowserState> {
    return api().getBrowserState();
  },

  updateBrowserSettings(settings: HostBridgeBrowserSettings): Promise<BoundaryBrowserUpdateResult> {
    return api().updateBrowserSettings(settings);
  },

  openBrowser(): Promise<{ success: boolean; error?: string }> {
    return api().openBrowser();
  },

  listGrants(): Promise<HostBridgeGrant[]> {
    return api().listGrants();
  },

  revokeGrant(grant: { capability: string; resource: string }): Promise<HostBridgeGrant[]> {
    return api().revokeGrant(grant);
  },

  revokeAllGrants(): Promise<HostBridgeGrant[]> {
    return api().revokeAllGrants();
  },
};
