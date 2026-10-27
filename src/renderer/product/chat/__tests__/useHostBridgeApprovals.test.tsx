import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { HostBridgeApprovalEvent } from '../../../../shared/types/hostBridge';
import { useHostBridgeApprovals } from '../useHostBridgeApprovals';

const approval = (id: string) =>
  ({ id, capability: 'notify', title: 'Show a notification', detail: 'x', choices: ['once', 'deny'], expiresAt: 0 }) as HostBridgeApprovalEvent;

function setup() {
  let resolveList: (list: HostBridgeApprovalEvent[]) => void = () => undefined;
  let rejectList: (err: Error) => void = () => undefined;
  let cleared: (event: { id: string }) => void = () => undefined;
  stubElectronAPI({
    hostBridge: {
      listPendingApprovals: vi.fn(
        () =>
          new Promise<HostBridgeApprovalEvent[]>((resolve, reject) => {
            resolveList = resolve;
            rejectList = reject;
          })
      ),
      onApproval: vi.fn(() => () => undefined),
      onApprovalCleared: vi.fn((cb: (event: { id: string }) => void) => {
        cleared = cb;
        return () => undefined;
      }),
    },
  });
  return {
    resolveList: (list: HostBridgeApprovalEvent[]) => resolveList(list),
    rejectList: (err: Error) => rejectList(err),
    clear: (id: string) => cleared({ id }),
  };
}

describe('useHostBridgeApprovals (G17-13)', () => {
  afterEach(() => cleanup());

  it('does not bring back an approval cleared while the pending list was loading', async () => {
    const ipc = setup();
    const { result } = renderHook(() => useHostBridgeApprovals());
    act(() => ipc.clear('a1'));
    await act(async () => ipc.resolveList([approval('a1'), approval('a2')]));
    expect(result.current.approval?.id).toBe('a2');
    expect(result.current.queueSize).toBe(1);
  });

  it('handles a failed list and a list that lands after unmount', async () => {
    const failing = setup();
    const first = renderHook(() => useHostBridgeApprovals());
    await act(async () => failing.rejectList(new Error('main gone')));
    expect(first.result.current.approval).toBeNull();

    const late = setup();
    const second = renderHook(() => useHostBridgeApprovals());
    second.unmount();
    await act(async () => late.resolveList([approval('a1')]));
    expect(second.result.current.approval).toBeNull();
  });
});
