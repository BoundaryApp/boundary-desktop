import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../../__tests__/electronApiFake';
import { getCallService, resetCallServiceForTests } from '../callService';
import { useCircleCall } from '../useCircleCall';
import { installCallFakes, stopped, type CallFakes } from './callFakes';

const KEY = 'cc'.repeat(32);
const MAYA = 'b2'.repeat(32);

let fakes: CallFakes;

class FakePeerConnection extends EventTarget {
  iceGatheringState = 'complete';
  connectionState = 'new';
  addTransceiver(kind: string) {
    return { kind, mid: '0', sender: { replaceTrack: async (): Promise<void> => undefined } };
  }
  getTransceivers(): RTCRtpTransceiver[] {
    return [];
  }
  close() {}
}

describe('useCircleCall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCallServiceForTests();
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    fakes = installCallFakes({ circles: [KEY], identity: 'a1'.repeat(32) });
  });
  afterEach(() => {
    resetCallServiceForTests();
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lists a Circle's live rooms from call events", () => {
    const { result } = renderHook(() => useCircleCall(KEY));
    act(() =>
      fakes.deliver({ circleKey: KEY, from: MAYA, device: 'dd'.repeat(32), topic: 'call.state', state: { room: 'channel/abc', s: '0123456789abcdef', muted: false, camera: true } })
    );
    expect(result.current.rooms).toEqual([
      { room: 'channel/abc', people: [{ identity: MAYA, s: '0123456789abcdef', muted: false, camera: true, device: 'dd'.repeat(32) }] },
    ]);
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.rooms).toEqual([]);
  });

  it("doesn't list a call with one person as a Circle room", () => {
    const { result } = renderHook(() => useCircleCall(KEY));
    act(() =>
      fakes.deliver({ circleKey: KEY, from: MAYA, device: 'dd'.repeat(32), topic: 'call.state', state: { room: 'person/0123456789abcdef', s: '0123456789abcdef', muted: false, camera: false } })
    );
    expect(result.current.rooms).toEqual([]);
  });

  it('join asks for the microphone and not the camera when video is off', async () => {
    const { result } = renderHook(() => useCircleCall(KEY));
    await act(async () => {
      await result.current.join('check', { audio: true, video: false });
    });
    expect(fakes.access).toEqual(['microphone']);
    expect(fakes.asked).toEqual([{ audio: true }]);
    expect(result.current.call?.room).toBe('check');
    expect(fakes.sent[0]).toMatchObject({ key: KEY, topic: 'call.state', state: { room: 'check', muted: false, camera: false } });
  });

  it('joining a second room leaves the first', async () => {
    const { result } = renderHook(() => useCircleCall(KEY));
    await act(async () => {
      await result.current.join('one', { audio: true, video: false });
    });
    const first = result.current.call!;
    await act(async () => {
      await result.current.join('two', { audio: true, video: false });
    });
    expect(result.current.call?.room).toBe('two');
    expect(fakes.sent).toContainEqual(expect.objectContaining({ topic: 'call.state', state: expect.objectContaining({ room: 'one', left: true }) }));
    expect(first.localStream.getTracks().every((track) => (track.stop as ReturnType<typeof vi.fn>).mock.calls.length === 1)).toBe(true);
  });

  it('joins without a device macOS denied', async () => {
    stubElectronAPI({ media: { requestAccess: async () => 'denied' } });
    const { result } = renderHook(() => useCircleCall(KEY));
    await act(async () => {
      await result.current.join('check', { audio: true, video: true });
    });
    expect(fakes.asked).toEqual([]);
    expect(result.current.call?.localStream.getTracks()).toEqual([]);
  });

  it('a join cancelled while its devices open leaves no call and stops its tracks', async () => {
    fakes.hold = { release: () => undefined };
    const { result } = renderHook(() => useCircleCall(KEY));
    let joined: Promise<unknown> = Promise.resolve();
    await act(async () => {
      joined = result.current.join('check', { audio: true, video: false }).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => getCallService().cancel());
    await act(async () => {
      fakes.hold!.release();
      await joined;
    });
    expect(await joined).toBe('The join was cancelled.');
    expect(result.current.call).toBeNull();
    expect(fakes.made.every(stopped)).toBe(true);
    expect(fakes.sent).toEqual([]);
  });

  it('two joins at once keep only the second', async () => {
    fakes.hold = { release: () => undefined };
    const { result } = renderHook(() => useCircleCall(KEY));
    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.join('one', { audio: true, video: false }).catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
    });
    const releaseFirst = fakes.hold!.release;
    fakes.hold = null;
    await act(async () => {
      await result.current.join('two', { audio: true, video: false });
    });
    await act(async () => {
      releaseFirst();
      await first;
    });
    expect(result.current.call?.room).toBe('two');
    expect(stopped(fakes.made[1])).toBe(true);
    expect(stopped(fakes.made[0])).toBe(false);
    expect(fakes.sent.some((input) => (input as { state?: { room: string } }).state?.room === 'one')).toBe(false);
  });

  it('leaving while the camera opens stops the camera', async () => {
    const { result } = renderHook(() => useCircleCall(KEY));
    await act(async () => {
      await result.current.join('check', { audio: true, video: false });
    });
    const call = result.current.call!;
    fakes.hold = { release: () => undefined };
    let opened: Promise<void> = Promise.resolve();
    await act(async () => {
      opened = call.setCamera(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => call.leave());
    await act(async () => {
      fakes.hold!.release();
      await opened;
    });
    const camera = fakes.made.find((track) => track.kind === 'video')!;
    expect(stopped(camera)).toBe(true);
    expect(call.localStream.getVideoTracks()).toEqual([]);
  });
});
