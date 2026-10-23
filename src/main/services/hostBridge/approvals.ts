import { randomUUID } from 'node:crypto';
import type {
  HostBridgeApprovalChoice,
  HostBridgeApprovalEvent,
} from '../../../shared/types/hostBridge';

/**
 * Approvals that Boundary raises for host-bridge calls (ADR 0027 §7). Unlike Hermes's own
 * approvals, these start in main: the card shows Boundary's reading of the call, and the answer
 * never travels through Hermes.
 *
 * A request nobody answers is denied after `APPROVAL_TIMEOUT_MS`, comfortably inside the MCP
 * call timeout Boundary sets in Hermes (180 s), so Hermes hears "denied" rather than a timeout.
 */

export const APPROVAL_TIMEOUT_MS = 120_000;

export const HOST_BRIDGE_APPROVAL_CHANNEL = 'host-bridge:approval';
export const HOST_BRIDGE_APPROVAL_CLEARED_CHANNEL = 'host-bridge:approval-cleared';

export type ApprovalOutcome = HostBridgeApprovalChoice | 'timeout';

type Send = (channel: string, payload: unknown) => void;

interface Pending {
  event: HostBridgeApprovalEvent;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let send: Send = () => {
  /* no window to tell until main sets the sender */
};

/** Main wires this to a broadcast over every window's webContents. */
export function setHostBridgeApprovalSender(sender: Send): void {
  send = sender;
}

export function requestHostBridgeApproval(
  request: Omit<HostBridgeApprovalEvent, 'id' | 'expiresAt' | 'choices'>,
  timeoutMs = APPROVAL_TIMEOUT_MS
): Promise<ApprovalOutcome> {
  const event: HostBridgeApprovalEvent = {
    ...request,
    id: randomUUID(),
    // No "Always allow" for calls that must ask every time (they carry no alwaysDescription).
    choices: request.alwaysDescription ? ['allow', 'always', 'deny'] : ['allow', 'deny'],
    expiresAt: Date.now() + timeoutMs,
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(event.id, 'timeout'), timeoutMs);
    timer.unref?.();
    pending.set(event.id, { event, resolve, timer });
    send(HOST_BRIDGE_APPROVAL_CHANNEL, event);
  });
}

function settle(id: string, outcome: ApprovalOutcome): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(outcome);
  send(HOST_BRIDGE_APPROVAL_CLEARED_CHANNEL, { id });
  return true;
}

export function respondToHostBridgeApproval(id: string, choice: HostBridgeApprovalChoice): boolean {
  const entry = pending.get(id);
  if (!entry || !entry.event.choices.includes(choice)) return false;
  return settle(id, choice);
}

/** For a renderer that mounts after the request went out. */
export function listPendingHostBridgeApprovals(): HostBridgeApprovalEvent[] {
  return [...pending.values()].map((entry) => entry.event);
}

/** Deny everything outstanding (bridge stopping). */
export function denyAllHostBridgeApprovals(): void {
  for (const id of [...pending.keys()]) settle(id, 'deny');
}
