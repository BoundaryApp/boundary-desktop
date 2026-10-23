import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_BRIDGE_APPROVAL_CHANNEL,
  HOST_BRIDGE_APPROVAL_CLEARED_CHANNEL,
  denyAllHostBridgeApprovals,
  listPendingHostBridgeApprovals,
  requestHostBridgeApproval,
  respondToHostBridgeApproval,
  setHostBridgeApprovalSender,
} from '../approvals';
import type { HostBridgeApprovalEvent } from '../../../../shared/types/hostBridge';

const request = { capability: 'notify', title: 'Show a notification', detail: 'Hi', alwaysDescription: 'x' };
let sent: Array<[string, unknown]>;

beforeEach(() => {
  sent = [];
  setHostBridgeApprovalSender((channel, payload) => sent.push([channel, payload]));
});

afterEach(() => {
  denyAllHostBridgeApprovals();
  vi.useRealTimers();
});

function lastEvent(): HostBridgeApprovalEvent {
  return sent.filter(([channel]) => channel === HOST_BRIDGE_APPROVAL_CHANNEL).at(-1)?.[1] as HostBridgeApprovalEvent;
}

describe('host-bridge approvals', () => {
  it('sends the request, resolves with the answer, and clears it', async () => {
    const outcome = requestHostBridgeApproval(request);
    const event = lastEvent();
    expect(event.choices).toEqual(['allow', 'always', 'deny']);
    expect(listPendingHostBridgeApprovals()).toHaveLength(1);
    expect(respondToHostBridgeApproval(event.id, 'allow')).toBe(true);
    await expect(outcome).resolves.toBe('allow');
    expect(sent).toContainEqual([HOST_BRIDGE_APPROVAL_CLEARED_CHANNEL, { id: event.id }]);
    expect(listPendingHostBridgeApprovals()).toHaveLength(0);
    expect(respondToHostBridgeApproval(event.id, 'deny')).toBe(false);
  });

  it('ignores answers that were not offered', () => {
    void requestHostBridgeApproval(request);
    expect(respondToHostBridgeApproval(lastEvent().id, 'session' as never)).toBe(false);
  });

  it('times out to "timeout" and clears the card', async () => {
    vi.useFakeTimers();
    const outcome = requestHostBridgeApproval(request, 1_000);
    const { id } = lastEvent();
    vi.advanceTimersByTime(1_001);
    await expect(outcome).resolves.toBe('timeout');
    expect(sent).toContainEqual([HOST_BRIDGE_APPROVAL_CLEARED_CHANNEL, { id }]);
  });

  it('denies everything outstanding when the bridge stops', async () => {
    const a = requestHostBridgeApproval(request);
    const b = requestHostBridgeApproval(request);
    denyAllHostBridgeApprovals();
    await expect(Promise.all([a, b])).resolves.toEqual(['deny', 'deny']);
  });
});
