import { describe, expect, it, vi } from 'vitest';
import type { LinkState } from '../../../../../shared/calls/callSession';
import { createWebrtcPeer } from '../webrtcPeer';

/** Just enough of RTCPeerConnection to see what the peer link asks of it. */
class FakePeerConnection extends EventTarget {
  static last: FakePeerConnection;
  config: RTCConfiguration;
  candidates: RTCIceCandidateInit[] = [];
  transceivers: {
    kind: string;
    mid: string;
    direction: string;
    fromOffer: boolean;
    receiver: { track: { kind: string } };
    sender: { track: MediaStreamTrack | null; replaceTrack: (track: MediaStreamTrack | null) => Promise<void> };
  }[] = [];
  local: RTCSessionDescriptionInit | null = null;
  remote: RTCSessionDescriptionInit | null = null;
  iceGatheringState = 'complete';
  connectionState = 'new';
  closed = false;
  constructor(config: RTCConfiguration) {
    super();
    this.config = config;
    FakePeerConnection.last = this;
  }
  addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit, fromOffer = false) {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const sender = {
      track: typeof trackOrKind === 'string' ? null : trackOrKind,
      replaceTrack: async (track: MediaStreamTrack | null) => {
        sender.track = track;
      },
    };
    const transceiver = { kind, mid: String(this.transceivers.length), direction: init?.direction ?? 'sendrecv', fromOffer, receiver: { track: { kind } }, sender };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() {
    return this.transceivers;
  }
  async createOffer() {
    return { type: 'offer' as const, sdp: 'v=0 offer' };
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'v=0 answer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.local = description;
  }
  /**
   * As in Chromium (JSEP 5.10): a remote offer reuses only transceivers that addTrack made, so
   * each of its m-sections here gets a new recvonly transceiver.
   */
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remote = description;
    if (description.type === 'offer') {
      this.addTransceiver('audio', { direction: 'recvonly' }, true);
      this.addTransceiver('video', { direction: 'recvonly' }, true);
    }
  }
  get localDescription() {
    return this.local;
  }
  async getStats() {
    return [{ id: 't', type: 'transport' }];
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  setConnection(state: string) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  /** One candidate arriving while gathering, as Chromium reports it. */
  found() {
    this.dispatchEvent(new Event('icecandidate'));
  }
  close() {
    this.closed = true;
  }
}

const track = (kind: string) => ({ kind, enabled: true, stop: (): void => undefined }) as unknown as MediaStreamTrack;

function peer(tracks: MediaStreamTrack[] = [track('audio')]) {
  return createWebrtcPeer({
    iceServers: [{ urls: 'stun:stun.example.com:3478' }],
    tracks,
    PeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
  });
}

describe('createWebrtcPeer', () => {
  it('adds the tunnel as the lowest-priority candidate', async () => {
    const link = peer();
    await link.offer();
    await link.accept('v=0 answer');
    await link.addTunnel(50123);
    expect(FakePeerConnection.last.candidates).toEqual([
      { candidate: 'candidate:tunnel 1 udp 1000 127.0.0.1 50123 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
  });

  it('remembers the tunnel port and reads its stats', async () => {
    const link = peer();
    expect(link.tunnelPort).toBeNull();
    await link.offer();
    await link.accept('v=0 answer');
    await link.addTunnel(50123);
    expect(link.tunnelPort).toBe(50123);
    expect(await link.getStats()).toEqual([{ id: 't', type: 'transport' }]);
  });

  it('offers audio and video, empty where there is no track', async () => {
    const link = peer([track('audio')]);
    await link.offer();
    const pc = FakePeerConnection.last;
    expect(pc.config.iceServers).toEqual([{ urls: 'stun:stun.example.com:3478' }]);
    expect(pc.transceivers.map((t) => [t.kind, t.direction, t.sender.track?.kind ?? null])).toEqual([
      ['audio', 'sendrecv', 'audio'],
      ['video', 'sendrecv', null],
    ]);
  });

  it('the answering side sends its tracks on the transceivers the offer made', async () => {
    const mic = track('audio');
    const link = peer([mic]);
    await link.answer('v=0 offer');
    const pc = FakePeerConnection.last;
    expect(pc.transceivers.map((t) => [t.kind, t.direction, t.fromOffer, t.sender.track])).toEqual([
      ['audio', 'sendrecv', true, mic],
      ['video', 'sendrecv', true, null],
    ]);
    const camera = track('video');
    await link.setTrack('video', camera);
    expect(pc.transceivers[1].sender.track).toBe(camera);
  });

  it('offers and answers with the gathered description', async () => {
    const caller = peer();
    expect(await caller.offer()).toBe('v=0 offer');
    const answerer = peer();
    expect(await answerer.answer('v=0 offer')).toBe('v=0 answer');
    expect(FakePeerConnection.last.remote).toEqual({ type: 'offer', sdp: 'v=0 offer' });
  });

  it('sends what it has after 5 seconds when gathering never finishes', async () => {
    vi.useFakeTimers();
    try {
      const link = peer();
      FakePeerConnection.last.iceGatheringState = 'gathering';
      let sdp: string | null = null;
      void link.offer().then((value) => (sdp = value));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(sdp).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(sdp).toBe('v=0 offer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends 1.5 seconds after the last candidate, without waiting out a dead STUN server', async () => {
    vi.useFakeTimers();
    try {
      const link = peer();
      const pc = FakePeerConnection.last;
      pc.iceGatheringState = 'gathering';
      let sdp: string | null = null;
      void link.offer().then((value) => (sdp = value));
      await vi.advanceTimersByTimeAsync(100);
      pc.found();
      await vi.advanceTimersByTimeAsync(1_499);
      expect(sdp).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(sdp).toBe('v=0 offer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the wait back for each candidate, so a slow one still gets in', async () => {
    vi.useFakeTimers();
    try {
      const link = peer();
      const pc = FakePeerConnection.last;
      pc.iceGatheringState = 'gathering';
      let sdp: string | null = null;
      void link.offer().then((value) => (sdp = value));
      await vi.advanceTimersByTimeAsync(100);
      pc.found();
      await vi.advanceTimersByTimeAsync(1_000);
      pc.found();
      // The first candidate's 1.5 s would have been up by now.
      await vi.advanceTimersByTimeAsync(600);
      expect(sdp).toBeNull();
      await vi.advanceTimersByTimeAsync(900);
      expect(sdp).toBe('v=0 offer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports connected and failed, and swaps the video track', async () => {
    const link = peer();
    await link.offer();
    const seen: LinkState[] = [];
    link.onState((state) => seen.push(state));
    FakePeerConnection.last.setConnection('connected');
    FakePeerConnection.last.setConnection('failed');
    expect(seen).toEqual(['connected', 'failed']);
    const camera = track('video');
    await link.setTrack('video', camera);
    expect(FakePeerConnection.last.transceivers[1].sender.track).toBe(camera);
    link.close();
    expect(FakePeerConnection.last.closed).toBe(true);
  });
});
