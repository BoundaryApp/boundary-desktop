import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCallService, resetCallServiceForTests } from '../callService';
import { closeCallView, openCallView, openCallViewOnJoin, useCallViewOpen } from '../callViewState';
import { installCallFakes, type CallFakes } from './callFakes';

vi.mock('../../../useAppShortcuts', () => ({ dispatchAppCommand: vi.fn() }));

const KEY = 'cc'.repeat(32);
const SAM = 'c3'.repeat(32);

let fakes: CallFakes;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

describe('the call view', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCallServiceForTests();
    closeCallView();
    fakes = installCallFakes({ circles: [KEY], identity: 'a1'.repeat(32) });
  });
  afterEach(() => {
    resetCallServiceForTests();
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('closes when the call ends, so the next call does not open in it', async () => {
    const view = renderHook(() => useCallViewOpen());
    const call = await act(() => getCallService().call(KEY, SAM, { audio: true, video: false }));
    act(() => openCallView());
    expect(view.result.current).toBe(true);
    act(() => call.leave());
    expect(view.result.current).toBe(false);
    await act(() => getCallService().call(KEY, SAM, { audio: true, video: false }));
    expect(view.result.current).toBe(false);
  });

  it('opens once a placed call has joined', async () => {
    const view = renderHook(() => useCallViewOpen());
    act(() => openCallViewOnJoin(getCallService().call(KEY, SAM, { audio: true, video: false })));
    expect(view.result.current).toBe(false);
    await settle();
    expect(view.result.current).toBe(true);
  });

  it('opens nothing for a join that was overtaken or cancelled', async () => {
    const view = renderHook(() => useCallViewOpen());
    fakes.hold = { release: () => undefined };
    act(() => openCallViewOnJoin(getCallService().call(KEY, SAM, { audio: true, video: false })));
    await settle();
    act(() => getCallService().cancel());
    fakes.hold.release();
    await settle();
    expect(getCallService().current).toBeNull();
    expect(view.result.current).toBe(false);
  });

  it('stays open while switching calls, and closes if the new join fails', async () => {
    const view = renderHook(() => useCallViewOpen());
    await act(() => getCallService().call(KEY, SAM, { audio: true, video: false }));
    act(() => openCallView());
    fakes.hold = { release: () => undefined };
    let joining: Promise<unknown> = Promise.resolve();
    act(() => {
      joining = getCallService().join(KEY, 'person/1111111111111111', { audio: true, video: false }).catch((): undefined => undefined);
    });
    await settle();
    // The first call has left, and the second is still opening its microphone.
    expect(getCallService().current).toBeNull();
    expect(view.result.current).toBe(true);
    act(() => getCallService().cancel());
    fakes.hold.release();
    await act(() => joining);
    expect(view.result.current).toBe(false);
  });
});
