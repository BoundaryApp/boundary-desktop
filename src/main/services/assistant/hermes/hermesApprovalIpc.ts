import { listParkedApprovals, respondToParkedApproval } from './hermesApprovals';
import { getHermesGatewaySession } from './hermesGatewaySession';
import type {
  HermesChatApprovalEvent,
  HermesChatApprovalAckPayload,
  HermesChatApprovalRespondPayload,
} from '../../../../shared/types/hermesChat';

/**
 * Live approvals answer over the socket that asked; approvals replayed from `approval.pending`
 * answer with `approval.respond`. Both are parked with their own responder, so one path
 * validates and reports whether the answer was sent.
 */
export function handleHermesChatApprovalRespond(
  payload: HermesChatApprovalRespondPayload
): Promise<{ success: boolean; error?: string }> {
  return respondToParkedApproval(payload);
}

/**
 * Approvals waiting on the user, so a reopened window or reloaded renderer can show them
 * again. With a chat's id: that chat's, under its stored or runtime id, after asking Hermes
 * for any still in its queue that Boundary never saw (best effort).
 */
export async function listPendingApprovals(sessionId?: string): Promise<HermesChatApprovalEvent[]> {
  if (!sessionId) return listParkedApprovals();
  const gateway = getHermesGatewaySession();
  const storedId = gateway.storedSessionId(sessionId);
  const runtimeId = gateway.runtimeSessionId(storedId) ?? gateway.runtimeSessionId(sessionId);
  try {
    await gateway.replayPendingApprovals([runtimeId ?? sessionId]);
  } catch {
    /* the gateway is unreachable: list what is parked */
  }
  const ids = [...new Set([sessionId, storedId, runtimeId].filter((id): id is string => Boolean(id)))];
  return listParkedApprovals(ids);
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
