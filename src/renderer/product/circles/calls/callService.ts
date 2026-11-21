/**
 * The call service for this window (Circle calls spec, "The public seam"). It keeps the live
 * rooms of every Circle from `call.state`, and runs at most one call: joining another room leaves
 * the first. A call with one person rings them first; rings for this user wait in `rings` until
 * answered, declined or stopped. Media comes from the camera and microphone, asked for only when
 * about to be used.
 */
import { CALL_ANSWER_MS, CALL_STATE_EVERY_MS, CALL_STUN, type CallState } from '../../../../shared/calls/callMessages';
import {
  CALL_RING_TOPIC,
  Dialer,
  RingInbox,
  cleanCallRing,
  newPersonRoom,
  type CallRingMessage,
  type DialStatus,
  type Ring,
} from '../../../../shared/calls/callRing';
import { CallRooms } from '../../../../shared/calls/callRooms';
import { CallSession, type CallParticipant, type CallTransport, type LinkReport } from '../../../../shared/calls/callSession';
import { CallLogger } from './callLogger';
import type { CallPart } from '../../../../shared/callSignalParts';
import { Listeners } from '../../../../shared/calls/listeners';
import { createWebrtcPeer, type WebrtcPeer } from './webrtcPeer';
import type { CirclesState } from '../../../../shared/types/circles';
import { fallsBackToDefault } from './deviceFallback';

type Kind = 'audio' | 'video';

export interface Call {
  circleKey: string;
  room: string;
  /** This user's identity. */
  me: string;
  /** The one person a private call is with; null for a Circle's room. */
  with: string | null;
  /** How ringing the person is going, for a call this side placed; null otherwise. */
  dial: DialStatus | null;
  /** When the first participant connected. */
  connectedAt: number | null;
  participants: CallParticipant[];
  localStream: MediaStream;
  muted: boolean;
  camera: boolean;
  mute(on: boolean): void;
  setCamera(on: boolean): Promise<void>;
  /** Use another microphone or camera; a camera that's off is used once it's turned on. */
  setDevice(kind: Kind, deviceId: string): Promise<void>;
  retry(key: string): void;
  leave(): void;
  onChange(listener: () => void): () => void;
}

export interface JoinOptions {
  audio: boolean;
  video: boolean;
  /** Device ids; the system default when left out. */
  microphone?: string;
  camera?: string;
}

/** A call this side placed that ended before the person came. */
export interface Missed {
  circleKey: string;
  with: string;
  reason: 'no-answer' | 'busy' | 'declined';
}

function sendRing(key: string, to: string, ring: CallRingMessage): void {
  void window.electronAPI.circles.callSend({ key, topic: CALL_RING_TOPIC, to, ring }).catch(() => false);
}

const electronTransport: CallTransport = {
  sendState: (key: string, state: CallState, to?: string) => {
    void window.electronAPI.circles.callSend({ key, topic: 'call.state', state, ...(to ? { to } : {}) }).catch(() => false);
  },
  sendPart: (key: string, to: string, part: CallPart) =>
    window.electronAPI.circles.callSend({ key, topic: 'call.part', to, part }).catch(() => false),
  tunnel: async (action, key, to, tunnel, device) => {
    const result = await window.electronAPI.circles.callTunnel({ action, key, to, tunnel, ...(device ? { device } : {}) });
    return result.success && result.port ? result.port : null;
  },
};

/** One device asked for, or nothing when macOS says no or the device can't be opened. */
async function openDevice(kind: Kind, deviceId?: string): Promise<MediaStreamTrack | null> {
  const status = await window.electronAPI.media.requestAccess(kind === 'audio' ? 'microphone' : 'camera').catch(() => 'unknown');
  if (status !== 'granted' && status !== 'unknown') return null;
  const open = async (constraint: boolean | MediaTrackConstraints) => {
    const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: constraint } : { video: constraint });
    return stream.getTracks()[0] ?? null;
  };
  try {
    return await open(deviceId ? { deviceId: { exact: deviceId } } : true);
  } catch (error) {
    // A picked device that was unplugged since: the default one is better than no track.
    if (!deviceId || !fallsBackToDefault(error)) return null;
  }
  try {
    return await open(true);
  } catch {
    return null;
  }
}

class ActiveCall implements Call {
  readonly localStream: MediaStream;
  connectedAt: number | null = null;
  private links = new Set<WebrtcPeer>();
  private listeners = new Listeners();
  private left = false;
  private logger: CallLogger;
  private stopSession: () => void;
  private dialer: Dialer | null = null;

  constructor(
    readonly session: CallSession,
    readonly me: string,
    private readonly person: string | null,
    tracks: MediaStreamTrack[],
    private devices: { audio?: string; video?: string },
    private onLeave: (call: ActiveCall) => void
  ) {
    this.localStream = new MediaStream(tracks);
    this.stopSession = session.onChange(() => this.sessionChanged());
    this.logger = new CallLogger(session.session, (input) => void window.electronAPI.circles.callLog(input).catch(() => false));
  }

  get circleKey(): string {
    return this.session.circleKey;
  }
  get room(): string {
    return this.session.room;
  }
  get with(): string | null {
    return this.person;
  }
  get dial(): DialStatus | null {
    return this.dialer?.status ?? null;
  }
  get participants(): CallParticipant[] {
    return this.session.participants;
  }
  get muted(): boolean {
    return this.session.muted;
  }
  get camera(): boolean {
    return this.session.camera;
  }

  /** A peer link sending this call's current tracks; closing it forgets it. */
  newPeer(): WebrtcPeer {
    const link = createWebrtcPeer({ iceServers: [{ urls: CALL_STUN }], tracks: this.localStream.getTracks() });
    const close = link.close.bind(link);
    link.close = () => {
      this.links.delete(link);
      close();
    };
    this.links.add(link);
    return link;
  }

  /** The session's report of a connection connecting or ending, for the diagnostics log. */
  report(report: LinkReport): void {
    const link = report.link as WebrtcPeer;
    if (report.kind === 'connected') void this.logger.connected(report, link);
    else this.logger.ended(report, link);
  }

  mute(on: boolean): void {
    for (const track of this.localStream.getAudioTracks()) track.enabled = !on;
    this.session.setMuted(on);
  }

  async setCamera(on: boolean): Promise<void> {
    let track = this.localStream.getVideoTracks()[0] ?? null;
    if (on && !track) {
      track = await openDevice('video', this.devices.video);
      if (!track) return;
      // Left while the camera opened: don't leave it running.
      if (this.left) {
        track.stop();
        return;
      }
      this.localStream.addTrack(track);
    }
    if (!on && track) {
      track.stop();
      this.localStream.removeTrack(track);
      track = null;
    }
    await Promise.all([...this.links].map((link) => link.setTrack('video', track).catch((): undefined => undefined)));
    this.session.setCamera(on && track !== null);
  }

  async setDevice(kind: Kind, deviceId: string): Promise<void> {
    this.devices[kind] = deviceId;
    const old = (kind === 'audio' ? this.localStream.getAudioTracks() : this.localStream.getVideoTracks())[0];
    // A camera that's off opens on the chosen device when it's turned on.
    if (!old) return;
    const track = await openDevice(kind, deviceId);
    if (!track) return;
    // Left, or turned off, while the device opened: don't leave it running.
    if (this.left || !this.localStream.getTracks().includes(old)) {
      track.stop();
      return;
    }
    track.enabled = old.enabled;
    this.localStream.removeTrack(old);
    this.localStream.addTrack(track);
    old.stop();
    await Promise.all([...this.links].map((link) => link.setTrack(kind, track).catch((): undefined => undefined)));
  }

  retry(key: string): void {
    this.session.retry(key);
  }

  /** The devices this call has open, to join another room with the same ones. */
  joinOptions(): JoinOptions {
    return {
      audio: this.localStream.getAudioTracks().length > 0,
      video: this.localStream.getVideoTracks().length > 0,
      ...(this.devices.audio ? { microphone: this.devices.audio } : {}),
      ...(this.devices.video ? { camera: this.devices.video } : {}),
    };
  }

  /** Ring the person this call is with; `ended` hears a ring that stopped without them. */
  ring(ended: (reason: Missed['reason']) => void): void {
    if (this.left || !this.person || this.dialer) return;
    const to = this.person;
    const dialer = new Dialer({ room: this.room, to, send: (ring) => sendRing(this.circleKey, to, ring) });
    this.dialer = dialer;
    dialer.onChange(() => {
      const status = dialer.status;
      if (status === 'no-answer' || status === 'busy' || status === 'declined') ended(status);
      this.changed();
    });
    dialer.start();
    this.sessionChanged();
  }

  /** A ring reply from the person this call is ringing. */
  ringReply(from: string, message: CallRingMessage): void {
    this.dialer?.receive(from, message);
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    this.dialer?.stop();
    this.session.leave();
    this.logger.dispose();
    this.stopSession();
    for (const track of this.localStream.getTracks()) track.stop();
    this.onLeave(this);
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private sessionChanged(): void {
    if (this.left) return;
    if (this.session.over) {
      // The other person left a call with one person: nobody is left in it.
      this.leave();
      return;
    }
    const participants = this.session.participants;
    if (this.person && participants.some((participant) => participant.identity === this.person)) this.dialer?.arrived();
    if (this.connectedAt === null && participants.some((participant) => participant.state === 'connected')) this.connectedAt = Date.now();
    this.changed();
  }

  private changed(): void {
    this.listeners.emit();
  }
}

/** How often a ring that stopped repeating is looked for. */
const RING_CHECK_MS = 1_000;

export class CallService {
  readonly rooms = new CallRooms();
  private readonly inbox = new RingInbox();
  private ringList: Ring[] = [];
  private answeringList: Ring[] = [];
  /** Ends a call joined from a ring if the caller never shows in the room. */
  private callerWait: (() => void) | null = null;
  private missedCall: Missed | null = null;
  private active: ActiveCall | null = null;
  /** What main was last told about whether a call is live. */
  private live = false;
  /** Bumped by every join and cancel, so a join overtaken while devices open can tell. */
  private generation = 0;
  /** Joins still opening their devices. */
  private opening = 0;
  private listeners = new Listeners();
  private stopEvents: () => void;
  private stopState: () => void;
  private timer: ReturnType<typeof setInterval>;
  private ringTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.stopEvents = window.electronAPI.circles.onCall((event) => {
      if (event.topic === 'call.state') {
        this.rooms.see(event.circleKey, event.from, event.state, Date.now(), event.device);
        // The caller has someone with them: another of this user's devices answered.
        if ((event.state.peers ?? 0) >= 1) this.inbox.present(event.circleKey, event.from, event.state.room);
      } else if (event.topic === 'call.ring') this.ringEvent(event.circleKey, event.from, event.ring);
      else if (this.active && event.circleKey === this.active.circleKey) void this.active.session.receivePart(event.from, event.part);
    });
    this.stopState = window.electronAPI.circles.onState((state) => this.circlesChanged(state));
    this.rooms.onChange(() => this.changed());
    this.inbox.onChange(() => {
      this.ringList = this.inbox.rings;
      this.answeringList = this.inbox.answering;
      this.changed();
    });
    this.timer = setInterval(() => this.rooms.expire(Date.now()), CALL_STATE_EVERY_MS);
    // A reload or a new window starts with no call, whatever the page before it told main.
    void window.electronAPI.calls.setLive(false).catch((): undefined => undefined);
    this.ringTimer = setInterval(() => this.inbox.expire(Date.now()), RING_CHECK_MS);
  }

  /** This window's call, if it's in one. */
  get current(): Call | null {
    return this.active;
  }

  /**
   * Whether a join is still opening its devices. The call it replaces has already left, so
   * `current` is null for that moment without the user having left.
   */
  get joining(): boolean {
    return this.opening > 0;
  }

  /** Calls ringing for this user, oldest first. The same array until they change. */
  get rings(): Ring[] {
    return this.ringList;
  }

  /**
   * Rings this user answered and is choosing devices for, until joined, declined, cancelled by
   * the caller, answered on another device, or the caller stops waiting. The same array until
   * they change.
   */
  get answeringRings(): Ring[] {
    return this.answeringList;
  }

  /** The last call this side placed that ended before the person came, until cleared. */
  get missed(): Missed | null {
    return this.missedCall;
  }

  clearMissed(): void {
    if (!this.missedCall) return;
    this.missedCall = null;
    this.changed();
  }

  /**
   * Call one person: a fresh private room, rung until they come or the ring ends. If they're
   * ringing this user in that Circle already, answer and join their call instead, so neither
   * side hears busy.
   */
  async call(circleKey: string, identity: string, options: JoinOptions): Promise<Call> {
    this.clearMissed();
    const ringing = [...this.ringList, ...this.answeringList].find((ring) => ring.circleKey === circleKey && ring.from === identity);
    if (ringing) {
      this.answering(ringing);
      return this.joinRing(ringing, options);
    }
    const call = await this.open(circleKey, newPersonRoom(), options, identity);
    call.ring((reason) => {
      this.missedCall = { circleKey, with: identity, reason };
      call.leave();
    });
    return call;
  }

  /** Tell the caller this user is coming (choosing devices first), and hide the card. */
  answering(ring: Ring): void {
    sendRing(ring.circleKey, ring.from, { t: 'answering', room: ring.room });
    this.inbox.answer(ring.room, Date.now());
  }

  decline(ring: Ring): void {
    sendRing(ring.circleKey, ring.from, { t: 'decline', room: ring.room });
    this.inbox.dismiss(ring.room);
  }

  /**
   * Join the caller's room. The call ends, with nothing recorded as missed, if the caller hasn't
   * shown in it within `CALL_ANSWER_MS`: they may have hung up while devices were chosen.
   */
  async joinRing(ring: Ring, options: JoinOptions): Promise<Call> {
    this.inbox.dismiss(ring.room);
    const call = await this.open(ring.circleKey, ring.room, options, ring.from);
    this.stopCallerWait();
    const shown = () => call.participants.some((participant) => participant.identity === ring.from);
    if (shown()) return call;
    const stopWatching = call.onChange(() => {
      if (shown()) this.stopCallerWait();
    });
    const timer = setTimeout(() => {
      this.stopCallerWait();
      if (this.active === call) call.leave();
    }, CALL_ANSWER_MS);
    this.callerWait = () => {
      clearTimeout(timer);
      stopWatching();
    };
    return call;
  }

  /**
   * Join a room, leaving any call first. Rejects with "The join was cancelled." when `cancel` or
   * another join comes before the devices are open, and stops what it opened.
   */
  join(circleKey: string, room: string, options: JoinOptions): Promise<Call> {
    return this.open(circleKey, room, options, null);
  }

  private async open(circleKey: string, room: string, options: JoinOptions, withIdentity: string | null): Promise<ActiveCall> {
    this.opening++;
    try {
      return await this.openDevices(circleKey, room, options, withIdentity);
    } finally {
      this.opening--;
      // A join that failed or was overtaken leaves no call; say so now nothing is opening.
      if (!this.active && !this.joining) this.changed();
    }
  }

  private async openDevices(circleKey: string, room: string, options: JoinOptions, withIdentity: string | null): Promise<ActiveCall> {
    const generation = ++this.generation;
    this.active?.leave();
    // Any join makes an older missed call moot.
    this.missedCall = null;
    const tracks: MediaStreamTrack[] = [];
    const current = () => {
      if (generation === this.generation) return;
      for (const track of tracks) track.stop();
      throw new Error('The join was cancelled.');
    };
    const state = await window.electronAPI.circles.getState();
    current();
    const devices = { audio: options.microphone, video: options.camera };
    for (const kind of ['audio', 'video'] as const) {
      if (!options[kind]) continue;
      const track = await openDevice(kind, devices[kind]);
      if (track) tracks.push(track);
      current();
    }
    let call: ActiveCall | null = null;
    const session = new CallSession({
      circleKey,
      room,
      me: state.snapshot.identity,
      transport: electronTransport,
      rooms: this.rooms,
      newPeer: () => call!.newPeer(),
      report: (report) => call?.report(report),
      ...(withIdentity ? { with: withIdentity } : {}),
    });
    call = new ActiveCall(session, state.snapshot.identity, withIdentity, tracks, devices, (left) => {
      if (this.active !== left) return;
      this.active = null;
      this.changed();
    });
    call.onChange(() => this.changed());
    session.setCamera(tracks.some((track) => track.kind === 'video'));
    this.active = call;
    session.start();
    this.changed();
    return call;
  }

  /** Leave the call, and stop any join still opening its devices. */
  cancel(): void {
    this.generation++;
    this.active?.leave();
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  dispose(): void {
    this.stopCallerWait();
    this.cancel();
    this.stopEvents();
    this.stopState();
    clearInterval(this.timer);
    clearInterval(this.ringTimer);
  }

  private ringEvent(circleKey: string, from: string, value: unknown): void {
    const message = cleanCallRing(value);
    if (!message) return;
    const active = this.active;
    if (message.t === 'ring' && active) {
      // A repeat that crossed this window joining that very call.
      if (active.circleKey === circleKey && active.room === message.room) return;
      // Both pressed Call before either ring arrived. Both sides see both rooms, so the side
      // with the larger identity joins the other's room and the other keeps ringing in its own.
      if (active.circleKey === circleKey && active.with === from && active.dial === 'calling') {
        if (active.me < from) return;
        const ring: Ring = { circleKey, from, room: message.room, since: Date.now() };
        const options = active.joinOptions();
        this.answering(ring);
        void this.joinRing(ring, options).catch((): undefined => undefined);
        return;
      }
      sendRing(circleKey, from, { t: 'busy', room: message.room });
      return;
    }
    if (message.t === 'ring' || message.t === 'cancel') this.inbox.receive(circleKey, from, message, Date.now());
    else if (active && active.circleKey === circleKey) active.ringReply(from, message);
  }

  /** A Circle this user left or was removed from takes its call and its rings with it. */
  private circlesChanged(state: CirclesState): void {
    if (state.status !== 'running') return;
    const keys = new Set(state.snapshot.circles.map((circle) => circle.key));
    if (this.active && !keys.has(this.active.circleKey)) this.active.leave();
    this.inbox.keepCircles(keys);
  }

  private stopCallerWait(): void {
    const stop = this.callerWait;
    this.callerWait = null;
    stop?.();
  }

  private changed(): void {
    const live = this.active !== null;
    if (live !== this.live) {
      this.live = live;
      void window.electronAPI.calls.setLive(live).catch((): undefined => undefined);
    }
    this.listeners.emit();
  }
}

let service: CallService | null = null;

/** The window's call service, started on first use. */
export function getCallService(): CallService {
  service ??= new CallService();
  return service;
}

/** For tests: leave any call and forget the service. */
export function resetCallServiceForTests(): void {
  service?.dispose();
  service = null;
}
