/**
 * Fakes shared by the call service's tests: media tracks and streams, `getUserMedia`, and the
 * electronAPI leaves the service uses, with a way to play the other Mac's call events.
 */
import { vi } from 'vitest';
import { circleSnapshot, runningCircles } from '../../../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../../../__tests__/electronApiFake';
import type { RingAction, RingAlert } from '../../../../../shared/calls/ringAlert';
import type { CirclesState } from '../../../../../shared/types/circles';

export type CallEvent = Parameters<Parameters<typeof window.electronAPI.circles.onCall>[0]>[0];

const fakeTrack = (kind: string) => ({ kind, enabled: true, stop: vi.fn() }) as unknown as MediaStreamTrack;

export const stopped = (track: MediaStreamTrack) => (track.stop as ReturnType<typeof vi.fn>).mock.calls.length > 0;

/** happy-dom's MediaStream keeps no tracks it didn't make. */
class FakeMediaStream {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((other) => other !== track);
  }
}

export interface CallFakes {
  /** Play a call event from main. */
  deliver(event: CallEvent): void;
  /** Play a Circles state from main. */
  setState(state: CirclesState): void;
  /** What the service sent with `callSend`. */
  sent: unknown[];
  /** Devices macOS was asked about. */
  access: string[];
  /** Constraints `getUserMedia` was called with. */
  asked: MediaStreamConstraints[];
  /** Tracks `getUserMedia` made. */
  made: MediaStreamTrack[];
  /** What the service told main with `calls.setLive`. */
  live: boolean[];
  /** Device ids that no longer exist: asking for one with `exact` fails like a missing device. */
  gone: Set<string>;
  /** When set, `getUserMedia` waits until `release` is called. */
  hold: { release: () => void } | null;
  /** Each list of ringing calls the page sent main with `calls.setRings`. */
  ringAlerts: RingAlert[][];
  /** Play main's **Answer** or **Decline** from a ring's notification. */
  ringAction(action: RingAction): void;
  /** Play main telling the page to start or stop the ring sound. */
  ringSound(on: boolean): void;
}

/**
 * Install the fakes for one test: `circles` are this user's Circles, `identity` is theirs. A
 * whole Circles `state`, when given, is used instead of one built from them.
 */
export function installCallFakes({
  circles = [],
  identity = '',
  state: given,
}: { circles?: string[]; identity?: string; state?: CirclesState }): CallFakes {
  const fakes: CallFakes = {
    deliver: () => undefined,
    setState: () => undefined,
    sent: [],
    access: [],
    asked: [],
    made: [],
    live: [],
    gone: new Set(),
    hold: null,
    ringAlerts: [],
    ringAction: () => undefined,
    ringSound: () => undefined,
  };
  vi.stubGlobal('MediaStream', FakeMediaStream);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        fakes.asked.push(constraints);
        for (const kind of [constraints.audio, constraints.video]) {
          const exact = typeof kind === 'object' ? (kind.deviceId as ConstrainDOMStringParameters | undefined)?.exact : undefined;
          if (typeof exact === 'string' && fakes.gone.has(exact)) {
            throw Object.assign(new Error('Requested device not found'), { name: 'OverconstrainedError' });
          }
        }
        if (fakes.hold) await new Promise<void>((resolve) => (fakes.hold!.release = resolve));
        const track = constraints.audio ? fakeTrack('audio') : fakeTrack('video');
        fakes.made.push(track);
        return { getTracks: () => [track] };
      },
    },
  });
  const state = given ?? runningCircles({ circles: circles.map((key) => circleSnapshot({ key })), identity });
  stubElectronAPI({
    circles: {
      getState: async () => state,
      onState: (cb: (state: CirclesState) => void) => {
        fakes.setState = cb;
        return (): void => undefined;
      },
      onCall: (cb: (event: CallEvent) => void) => {
        fakes.deliver = cb;
        return (): void => undefined;
      },
      callSend: async (input: unknown) => {
        fakes.sent.push(input);
        return true;
      },
      callTunnel: async () => ({ success: false, error: 'no' }),
      callLog: async () => true,
    },
    media: {
      requestAccess: async (device: string) => {
        fakes.access.push(device);
        return 'granted';
      },
    },
    calls: {
      setLive: async (live: boolean) => {
        fakes.live.push(live);
      },
      setRings: async (rings: RingAlert[]) => {
        fakes.ringAlerts.push(rings);
      },
      onRingAction: (cb: (action: RingAction) => void) => {
        fakes.ringAction = cb;
        return (): void => undefined;
      },
      onRingSound: (cb: (on: boolean) => void) => {
        fakes.ringSound = cb;
        return (): void => undefined;
      },
    },
  });
  return fakes;
}
