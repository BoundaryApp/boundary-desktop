import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { circleSnapshot, runningCircles } from '../../../../__tests__/circleFixtures';
import { CALL_ANSWER_MS } from '../../../../../shared/calls/callMessages';
import { CALL_RING_MS } from '../../../../../shared/calls/callRing';
import type { LinkState } from '../../../../../shared/calls/callSession';
import { getCallService, resetCallServiceForTests } from '../callService';
import { useCallService } from '../useCallService';
import { installCallFakes, stopped, type CallEvent, type CallFakes } from './callFakes';

/** Links the service made, each with a way to play its connection state. */
const h = vi.hoisted(() => ({
  links: [] as Array<{ setTrack: ReturnType<typeof vi.fn>; state: (state: LinkState) => void }>,
}));

vi.mock('../webrtcPeer', () => ({
  createWebrtcPeer: () => {
    const listeners: Array<(state: LinkState) => void> = [];
    const link = {
      remote: new MediaStream(),
      tunnelPort: null as number | null,
      getStats: async (): Promise<Map<string, unknown>> => new Map(),
      offer: () => new Promise<string>(() => undefined),
      answer: () => new Promise<string>(() => undefined),
      accept: async (): Promise<void> => undefined,
      addTunnel: async (): Promise<void> => undefined,
      onState: (listener: (state: LinkState) => void) => listeners.push(listener),
      setTrack: vi.fn(async () => undefined),
      close: (): void => undefined,
      state: (state: LinkState) => listeners.forEach((listener) => listener(state)),
    };
    h.links.push(link);
    return link;
  },
}));

const KEY = 'cc'.repeat(32);
const KEY2 = 'dd'.repeat(32);
const ME = 'a1'.repeat(32);
const MAYA = 'b2'.repeat(32);
const SAM = 'c3'.repeat(32);
/** Sorts before ME. */
const LOW = '0f'.repeat(32);
const DEVICE = 'ee'.repeat(32);
const ROOM = 'person/0123456789abcdef';
const OTHER = 'person/1111111111111111';
/** Session ids above any this side makes, so this side offers and makes the link. */
const HIGH = 'ffffffffffffffff';
const HIGHER_BUT_ONE = 'fffffffffffffffe';
const AUDIO = { audio: true, video: false };

let fakes: CallFakes;

const ringEvent = (t: string, room = ROOM, from = MAYA, circleKey = KEY): CallEvent =>
  ({ circleKey, from, device: DEVICE, topic: 'call.ring', ring: { t, room } }) as CallEvent;
const stateEvent = (room: string, from: string, extra: Record<string, unknown> = {}): CallEvent =>
  ({ circleKey: KEY, from, device: DEVICE, topic: 'call.state', state: { room, s: HIGH, muted: false, camera: false, ...extra } }) as CallEvent;
const ringsSent = () =>
  fakes.sent.filter((input) => (input as { topic: string }).topic === 'call.ring') as Array<{ to: string; ring: { t: string; room: string } }>;

describe('CallService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.links.length = 0;
    resetCallServiceForTests();
    fakes = installCallFakes({ circles: [KEY, KEY2], identity: ME });
  });
  afterEach(() => {
    resetCallServiceForTests();
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('calling rings the person and shows answered once they arrive', async () => {
    const service = getCallService();
    const call = await service.call(KEY, MAYA, AUDIO);
    expect(call.with).toBe(MAYA);
    expect(call.dial).toBe('calling');
    expect(call.connectedAt).toBeNull();
    expect(call.room).toMatch(/^person\/[0-9a-f]{16}$/);
    expect(fakes.sent).toContainEqual({ key: KEY, topic: 'call.ring', to: MAYA, ring: { t: 'ring', room: call.room } });
    expect(fakes.sent).toContainEqual(expect.objectContaining({ topic: 'call.state', to: MAYA, state: expect.objectContaining({ room: call.room }) }));

    fakes.deliver(stateEvent(call.room, MAYA));
    expect(call.dial).toBe('answered');
    h.links[0].state('connected');
    expect(call.connectedAt).toBe(Date.now());
    // Past the 30 seconds a ring lasts, with Maya still saying she's here.
    for (let waited = 0; waited <= CALL_RING_MS; waited += 5_000) {
      vi.advanceTimersByTime(5_000);
      fakes.deliver(stateEvent(call.room, MAYA, { peers: 1 }));
    }
    expect(ringsSent().map((sent) => sent.ring.t)).not.toContain('cancel');
    expect(service.current).toBe(call);
  });

  it('no answer after 30 seconds leaves the room and records it', async () => {
    const service = getCallService();
    const call = await service.call(KEY, MAYA, AUDIO);
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(service.current).toBeNull();
    expect(service.missed).toEqual({ circleKey: KEY, with: MAYA, reason: 'no-answer' });
    expect(ringsSent().at(-1)).toEqual({ key: KEY, topic: 'call.ring', to: MAYA, ring: { t: 'cancel', room: call.room } });
    expect(fakes.sent).toContainEqual(expect.objectContaining({ topic: 'call.state', state: expect.objectContaining({ room: call.room, left: true }) }));
    expect(call.localStream.getTracks().every(stopped)).toBe(true);
    service.clearMissed();
    expect(service.missed).toBeNull();
  });

  it('busy and declined are recorded with their reason', async () => {
    const service = getCallService();
    let call = await service.call(KEY, MAYA, AUDIO);
    fakes.deliver(ringEvent('busy', call.room, SAM));
    expect(service.current).toBe(call);
    fakes.deliver(ringEvent('busy', call.room));
    expect(service.current).toBeNull();
    expect(service.missed).toEqual({ circleKey: KEY, with: MAYA, reason: 'busy' });

    call = await service.call(KEY, MAYA, AUDIO);
    expect(service.missed).toBeNull();
    fakes.deliver(ringEvent('decline', call.room));
    expect(service.current).toBeNull();
    expect(service.missed).toEqual({ circleKey: KEY, with: MAYA, reason: 'declined' });
  });

  it('joining any call clears a missed call', async () => {
    const service = getCallService();
    await service.call(KEY, MAYA, AUDIO);
    vi.advanceTimersByTime(CALL_RING_MS);
    expect(service.missed).not.toBeNull();
    await service.join(KEY, 'check', AUDIO);
    expect(service.missed).toBeNull();

    await service.call(KEY, MAYA, AUDIO);
    vi.advanceTimersByTime(CALL_RING_MS);
    fakes.deliver(ringEvent('ring', OTHER, SAM));
    expect(service.missed).not.toBeNull();
    await service.joinRing(service.rings[0], AUDIO);
    expect(service.missed).toBeNull();
  });

  it('calling someone who is ringing you joins their call', async () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    const call = await service.call(KEY, MAYA, AUDIO);
    expect(call.room).toBe(ROOM);
    expect(call.with).toBe(MAYA);
    expect(call.dial).toBeNull();
    expect(service.rings).toEqual([]);
    const sent = ringsSent();
    expect(sent.map((ring) => ring.ring.t)).not.toContain('ring');
    expect(sent).toContainEqual({ key: KEY, topic: 'call.ring', to: MAYA, ring: { t: 'answering', room: ROOM } });
    // A ring from the same person in another Circle isn't the same call.
    call.leave();
    fakes.deliver(ringEvent('ring', OTHER, MAYA, KEY2));
    const other = await service.call(KEY, MAYA, AUDIO);
    expect(other.room).not.toBe(OTHER);
    expect(other.dial).toBe('calling');
  });

  it('a ring while in a call answers busy and shows no card', async () => {
    const service = getCallService();
    await service.join(KEY, 'check', AUDIO);
    fakes.deliver(ringEvent('ring'));
    expect(service.rings).toEqual([]);
    expect(ringsSent()).toEqual([{ key: KEY, topic: 'call.ring', to: MAYA, ring: { t: 'busy', room: ROOM } }]);
  });

  it('calling each other at once: the larger identity joins the other room', async () => {
    const service = getCallService();
    // LOW sorts before this side's identity, so this side gives way.
    const mine = await service.call(KEY, LOW, AUDIO);
    expect(mine.dial).toBe('calling');
    fakes.deliver(ringEvent('ring', OTHER, LOW));
    await vi.advanceTimersByTimeAsync(0);

    const sent = ringsSent();
    expect(sent.map((ring) => ring.ring.t)).not.toContain('busy');
    expect(sent).toContainEqual({ key: KEY, topic: 'call.ring', to: LOW, ring: { t: 'cancel', room: mine.room } });
    expect(sent).toContainEqual({ key: KEY, topic: 'call.ring', to: LOW, ring: { t: 'answering', room: OTHER } });
    expect(service.current?.room).toBe(OTHER);
    expect(service.current?.with).toBe(LOW);
    expect(service.rings).toEqual([]);
    expect(service.missed).toBeNull();
  });

  it('calling each other at once: the smaller identity keeps ringing in its own room', async () => {
    const service = getCallService();
    // MAYA sorts after this side's identity, so she gives way and joins this room.
    const mine = await service.call(KEY, MAYA, AUDIO);
    fakes.deliver(ringEvent('ring', OTHER, MAYA));
    await vi.advanceTimersByTimeAsync(0);

    expect(ringsSent().map((ring) => ring.ring.t)).not.toContain('busy');
    expect(service.current).toBe(mine);
    expect(mine.dial).toBe('calling');
    expect(service.rings).toEqual([]);
    fakes.deliver(ringEvent('answering', mine.room, MAYA));
    fakes.deliver(stateEvent(mine.room, MAYA));
    expect(mine.dial).toBe('answered');
  });

  it('a ring from someone else while calling answers busy', async () => {
    const service = getCallService();
    await service.call(KEY, MAYA, AUDIO);
    fakes.deliver(ringEvent('ring', OTHER, LOW));
    expect(ringsSent()).toContainEqual({ key: KEY, topic: 'call.ring', to: LOW, ring: { t: 'busy', room: OTHER } });
  });

  it('answering tells the caller and joining enters the caller\'s room', async () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    expect(service.rings).toEqual([{ circleKey: KEY, from: MAYA, room: ROOM, since: Date.now() }]);
    const ring = service.rings[0];
    service.answering(ring);
    expect(ringsSent()).toEqual([{ key: KEY, topic: 'call.ring', to: MAYA, ring: { t: 'answering', room: ROOM } }]);
    expect(service.rings).toEqual([]);
    fakes.deliver(ringEvent('ring'));
    expect(service.rings).toEqual([]);

    const call = await service.joinRing(ring, AUDIO);
    expect(call.room).toBe(ROOM);
    expect(call.with).toBe(MAYA);
    expect(call.dial).toBeNull();
    expect(fakes.sent).toContainEqual(expect.objectContaining({ topic: 'call.state', to: MAYA, state: expect.objectContaining({ room: ROOM }) }));
    // A repeat that crossed the join isn't another call.
    fakes.deliver(ringEvent('ring'));
    expect(ringsSent()).toHaveLength(1);
  });

  it('an answered ring stays tracked until the caller cancels', () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    const ring = service.rings[0];
    service.answering(ring);
    expect(service.answeringRings).toEqual([ring]);
    expect(service.answeringRings).toBe(service.answeringRings);
    fakes.deliver(ringEvent('cancel'));
    expect(service.answeringRings).toEqual([]);
  });

  it('leaving the Circle drops a ring being answered', () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    service.answering(service.rings[0]);
    fakes.setState(runningCircles({ circles: [circleSnapshot({ key: KEY2 })], identity: ME }));
    expect(service.answeringRings).toEqual([]);
  });

  it("a call joined from a ring ends if the caller hasn't shown in 20 seconds", async () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    const ring = service.rings[0];
    service.answering(ring);
    const call = await service.joinRing(ring, AUDIO);
    expect(service.answeringRings).toEqual([]);
    vi.advanceTimersByTime(CALL_ANSWER_MS - 1);
    expect(service.current).toBe(call);
    vi.advanceTimersByTime(1);
    expect(service.current).toBeNull();
    expect(service.missed).toBeNull();
    expect(call.localStream.getTracks().every(stopped)).toBe(true);
  });

  it('a call joined from a ring stays once the caller has shown', async () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    const call = await service.joinRing(service.rings[0], AUDIO);
    // Maya keeps saying she's here, as a live caller does every 5 seconds.
    for (let waited = 0; waited < CALL_ANSWER_MS; waited += 5_000) {
      fakes.deliver(stateEvent(ROOM, MAYA));
      vi.advanceTimersByTime(5_000);
    }
    expect(service.current).toBe(call);
  });

  it('a call joined from a ring ends when the caller leaves before connecting', async () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    await service.joinRing(service.rings[0], AUDIO);
    fakes.deliver(stateEvent(ROOM, MAYA));
    fakes.deliver(stateEvent(ROOM, MAYA, { left: true }));
    expect(service.current).toBeNull();
    expect(service.missed).toBeNull();
  });

  it('declining tells the caller and drops the card', () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    service.decline(service.rings[0]);
    expect(ringsSent()).toEqual([{ key: KEY, topic: 'call.ring', to: MAYA, ring: { t: 'decline', room: ROOM } }]);
    expect(service.rings).toEqual([]);
  });

  it('a ring stops 12 seconds after its last repeat', () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    vi.advanceTimersByTime(11_000);
    expect(service.rings).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(service.rings).toEqual([]);
  });

  it('a second device stops ringing once the caller has someone', () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring'));
    fakes.deliver(stateEvent(ROOM, MAYA, { peers: 0 }));
    expect(service.rings).toHaveLength(1);
    fakes.deliver(stateEvent(ROOM, MAYA, { peers: 1 }));
    expect(service.rings).toEqual([]);
  });

  it('leaving the Circle ends the call and drops its rings', async () => {
    const service = getCallService();
    fakes.deliver(ringEvent('ring', ROOM, SAM, KEY));
    fakes.deliver(ringEvent('ring', OTHER, SAM, KEY2));
    const call = await service.call(KEY, MAYA, AUDIO);
    fakes.setState(runningCircles({ circles: [circleSnapshot({ key: KEY2 })], identity: ME }));
    expect(service.current).toBeNull();
    expect(service.missed).toBeNull();
    expect(service.rings).toEqual([expect.objectContaining({ circleKey: KEY2, room: OTHER })]);
    expect(call.localStream.getTracks().every(stopped)).toBe(true);
  });

  it('the call ends when the other person leaves', async () => {
    const service = getCallService();
    const call = await service.call(KEY, MAYA, AUDIO);
    fakes.deliver(stateEvent(call.room, MAYA));
    h.links[0].state('connected');
    fakes.deliver(stateEvent(call.room, MAYA, { left: true }));
    expect(service.current).toBeNull();
    expect(service.missed).toBeNull();
  });

  it('tells main whether a call is live, starting with none', async () => {
    const service = getCallService();
    // A reloaded page starts with no call, whatever the last page said.
    expect(fakes.live).toEqual([false]);
    const call = await service.join(KEY, 'check', AUDIO);
    expect(fakes.live).toEqual([false, true]);
    call.mute(true);
    expect(fakes.live).toEqual([false, true]);
    call.leave();
    expect(fakes.live).toEqual([false, true, false]);
  });

  it('switching the microphone replaces the track on every link', async () => {
    const service = getCallService();
    const call = await service.join(KEY, 'check', { ...AUDIO, microphone: 'mic-1' });
    expect(fakes.asked).toEqual([{ audio: { deviceId: { exact: 'mic-1' } } }]);
    fakes.deliver(stateEvent('check', MAYA));
    fakes.deliver({ ...stateEvent('check', SAM), state: { room: 'check', s: HIGHER_BUT_ONE, muted: false, camera: false } } as CallEvent);
    expect(h.links).toHaveLength(2);
    const old = call.localStream.getAudioTracks()[0];
    call.mute(true);

    await call.setDevice('audio', 'mic-2');
    expect(fakes.asked.at(-1)).toEqual({ audio: { deviceId: { exact: 'mic-2' } } });
    const next = fakes.made.at(-1)!;
    expect(call.localStream.getAudioTracks()).toEqual([next]);
    expect(next.enabled).toBe(false);
    expect(stopped(old)).toBe(true);
    for (const link of h.links) expect(link.setTrack).toHaveBeenCalledWith('audio', next);
  });

  it('falls back to the default microphone when the picked one is gone', async () => {
    fakes.gone.add('mic-1');
    const call = await getCallService().join(KEY, 'check', { ...AUDIO, microphone: 'mic-1' });
    expect(fakes.asked).toEqual([{ audio: { deviceId: { exact: 'mic-1' } } }, { audio: true }]);
    expect(call.localStream.getAudioTracks()).toHaveLength(1);
  });

  it('useCallService shows the call, the rings and a missed call', async () => {
    const { result } = renderHook(() => useCallService());
    expect(result.current).toMatchObject({ call: null, rings: [], missed: null });
    const first = result.current.rings;
    act(() => fakes.deliver(ringEvent('ring', OTHER, SAM)));
    expect(result.current.rings).toEqual([expect.objectContaining({ room: OTHER })]);
    expect(result.current.rings).not.toBe(first);
    let call = null as unknown;
    await act(async () => {
      call = await result.current.service.call(KEY, MAYA, AUDIO);
    });
    expect(result.current.call).toBe(call);
    act(() => vi.advanceTimersByTime(CALL_RING_MS));
    expect(result.current.call).toBeNull();
    expect(result.current.missed).toMatchObject({ reason: 'no-answer' });
  });
});
