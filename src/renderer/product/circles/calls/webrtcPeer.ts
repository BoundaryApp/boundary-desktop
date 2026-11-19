/**
 * The call session's peer link over WebRTC. Each link negotiates an audio and a video
 * transceiver, sending both ways even with no track yet, so turning the camera on or off swaps a
 * track instead of renegotiating. The offering side adds them; the answering side sends on the
 * ones the offer made.
 * Descriptions go whole, once candidates stop arriving (1.5 s) or gathering ends, 5 s at the most;
 * the tunnel endpoint goes in as a remote candidate below any real one (ADR 0044 §9).
 */
import type { LinkState, PeerLink } from '../../../../shared/calls/callSession';
import { tunnelCandidate } from '../callCheck';
import type { StatsSource } from './callLogger';

const GATHER_MS = 5_000;
/**
 * How long to wait after the last candidate. A STUN server that never answers holds gathering
 * open until Chromium's own timeout, which put 5 s on the front of every call; the candidates
 * that matter have all arrived long before that. Each new candidate puts the wait back, so a
 * slow server's reply still gets in.
 */
const QUIET_MS = 1_500;
const KINDS = ['audio', 'video'] as const;
type Kind = (typeof KINDS)[number];

export interface WebrtcPeer extends PeerLink, StatsSource {
  readonly remote: MediaStream;
  /** Send `track` (or nothing) as this link's audio or video. */
  setTrack(kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<void>;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(quiet);
      pc.removeEventListener('icegatheringstatechange', changed);
      pc.removeEventListener('icecandidate', found);
      resolve();
    };
    const changed = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const found = () => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, QUIET_MS);
    };
    const timer = setTimeout(finish, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', changed);
    pc.addEventListener('icecandidate', found);
  });
}

export function createWebrtcPeer(opts: {
  iceServers: RTCIceServer[];
  tracks: MediaStreamTrack[];
  PeerConnection?: typeof RTCPeerConnection;
}): WebrtcPeer {
  const PeerConnection = opts.PeerConnection ?? RTCPeerConnection;
  const pc = new PeerConnection({ iceServers: opts.iceServers });
  const local = new MediaStream(opts.tracks);
  let tracks = [...opts.tracks];
  const trackOf = (kind: Kind) => tracks.find((track) => track.kind === kind) ?? null;
  /** Each kind's sender, once the transceivers exist: made by an offer, or taken over from one. */
  const senders: Partial<Record<Kind, RTCRtpSender>> = {};
  const remote = new MediaStream();
  pc.addEventListener('track', (event) => {
    const { track } = event as RTCTrackEvent;
    if (!remote.getTracks().includes(track)) remote.addTrack(track);
  });

  let tunnelPort: number | null = null;

  return {
    remote,
    get tunnelPort() {
      return tunnelPort;
    },
    getStats: () => pc.getStats(),
    async offer() {
      for (const kind of KINDS) {
        senders[kind] = pc.addTransceiver(trackOf(kind) ?? kind, { direction: 'sendrecv', streams: [local] }).sender;
      }
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      return pc.localDescription?.sdp ?? '';
    },
    async answer(remoteSdp) {
      await pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
      // A remote offer makes its own transceivers (only addTrack's are reused, JSEP 5.10), so send
      // on those: the first of each kind.
      for (const kind of KINDS) {
        const transceiver = pc.getTransceivers().find((candidate) => candidate.receiver.track.kind === kind);
        if (!transceiver) continue;
        transceiver.direction = 'sendrecv';
        await transceiver.sender.replaceTrack(trackOf(kind));
        senders[kind] = transceiver.sender;
      }
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      return pc.localDescription?.sdp ?? '';
    },
    async accept(remoteSdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp });
    },
    async addTunnel(port) {
      tunnelPort = port;
      await pc.addIceCandidate(tunnelCandidate(port, pc.getTransceivers()[0]?.mid ?? null));
    },
    onState(listener: (state: LinkState) => void) {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') listener('connected');
        else if (pc.connectionState === 'failed') listener('failed');
      });
    },
    async setTrack(kind, track) {
      tracks = [...tracks.filter((other) => other.kind !== kind), ...(track ? [track] : [])];
      await senders[kind]?.replaceTrack(track);
    },
    close() {
      pc.close();
    },
  };
}
