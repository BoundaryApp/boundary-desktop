import {
  listParkedApprovals,
  respondToParkedApproval,
} from './hermesApprovals';
import {
  getHermesGatewaySession,
  pendingViaQueue,
} from './hermesGatewaySession';
import type {
  HermesChatApprovalAckPayload,
  HermesChatApprovalRespondPayload,
} from '../../../../shared/types/hermesChat';

export async function handleHermesChatApprovalRespond(
  payload: HermesChatApprovalRespondPayload
): Promise<{ success: boolean; error?: string }> {
  if (pendingViaQueue.has(payload.rpcRequestId)) {
    const parked = listParkedApprovals().find(
      (a) => a.rpcRequestId === payload.rpcRequestId
    );
    if (!parked) {
      return { success: false, error: 'No pending approval for that request' };
    }
    try {
      const gateway = getHermesGatewaySession();
      await gateway.respondPendingApproval({
        sessionId: parked.sessionId,
        approvalRequestId: parked.approvalRequestId,
        choice: payload.choice,
        all: payload.all,
      });
      pendingViaQueue.delete(payload.rpcRequestId);
      // Drop the synthetic park entry (respond is a no-op for synthetics).
      respondToParkedApproval(payload);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return respondToParkedApproval(payload);
}

export async function handleHermesChatApprovalReceived(
  payload: HermesChatApprovalAckPayload
): Promise<{ success: boolean; error?: string }> {
  if (!payload.sessionId || !payload.approvalRequestId) {
    return { success: false, error: 'Missing approval identity' };
  }
  try {
    const gateway = getHermesGatewaySession();
    await gateway.ackApprovalReceived({
      sessionId: payload.sessionId,
      approvalRequestId: payload.approvalRequestId,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
