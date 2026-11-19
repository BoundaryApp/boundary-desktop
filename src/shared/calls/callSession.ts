/**
 * One device's place in a call room (ADR 0044 §2, §9). Everyone in the room connects to everyone
 * else: of each pair, the session with the smaller id offers, so two devices that join at once
 * still make one connection. A person's other devices in the same room are left out, so they
 * don't hear themselves. Offers, answers and goodbyes travel as compressed parts over peer
 * signals; each connection may also get a tunnel over the Circles connection, which the peer link
 * adds as its lowest-priority candidate. The peer link is supplied by the caller (WebRTC in the
 * renderer, a fake in tests), so this file needs no DOM.
 */
import { CallPartAssembler, isCallPart, packCallMessage, type CallPart } from '../callSignalParts';
import {
  CALL_ANSWER_MS,
  CALL_CONNECT_MS,
  CALL_GONE_MS,
  CALL_STATE_EVERY_MS,
  cleanCallMessage,
  type CallMessage,
  type CallState,
} from './callMessages';
import type { CallRooms, RoomPerson } from './callRooms';
import { Listeners } from './listeners';

export interface CallTransport {
  /** Tell the whole Circle this device's state, or only `to` when given. */
  sendState(circleKey: string, state: CallState, to?: string): void;
  sendPart(circleKey: string, to: string, part: CallPart): Promise<boolean>;
  /** Open or close a tunnel to one member; `open` resolves to its local port, or null. */
  tunnel(action: 'open' | 'close', circleKey: string, to: string, id: number, device?: string): Promise<number | null>;
}

export type LinkState = 'connecting' | 'connected' | 'failed';

/** One media connection to one other device. */
export interface PeerLink {
  /** Create an offer and return its description, candidates gathered. */
  offer(): Promise<string>;
  /** Take an offer and return the answer's description, candidates gathered. */
  answer(remoteSdp: string): Promise<string>;
  /** Take the answer to this link's offer. */
  accept(remoteSdp: string): Promise<void>;
  /** Add the tunnel endpoint as a remote candidate, after the remote description is set. */
  addTunnel(port: number): Promise<void>;
  onState(listener: (state: LinkState) => void): void;
  /** What arrives from the other device; a `MediaStream` in the renderer. */
  readonly remote: unknown;
  close(): void;
}

export type PeerFactory = () => PeerLink;

/** What happened to one connection, for a log that holds metadata only. */
export type LinkReport =
  | { kind: 'connected'; key: string; identity: string; role: 'offer' | 'answer'; ms: number; link: PeerLink }
  | { kind: 'ended'; key: string; identity: string; seconds: number; link: PeerLink };

export type PersonState = 'connecting' | 'connected' | 'unreachable';

export interface CallParticipant {
  /** `${identity}/${s}` */
  key: string;
  identity: string;
  s: string;
  muted: boolean;
  camera: boolean;
  /** The device (64 hex) that sent its state, when known; its tunnel goes there. */
  device?: string;
  state: PersonState;
  remote: unknown;
}

interface Peer extends CallParticipant {
  link: PeerLink | null;
  /** `device` is where the tunnel was opened, so closing it goes to the same one. */
  tunnel: { id: number; port: number | null; device?: string } | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Whether `call.state` has listed this session yet; one known only from its offer hasn't. */
  listed: boolean;
  /** Bumped whenever the connection starts over, so a stale async step can tell. */
  attempt: number;
  /** This side has an offer out that hasn't been answered. */
  offering: boolean;
  /** When the current link was made, which side it plays, and when it connected. */
  linkStarted: number;
  linkRole: 'offer' | 'answer';
  connectedAt: number | null;
}

function randomSession(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomTunnelId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] & 0xffffff) || 1;
}

export class CallSession {
  readonly circleKey: string;
  readonly room: string;
  readonly session: string;
  muted = false;
  camera = false;
  /** A private session sets this once the other person has been in the room and is gone. */
  over = false;

  private me: string;
  private transport: CallTransport;
  private rooms: CallRooms;
  private newPeer: PeerFactory;
  private report: (report: LinkReport) => void;
  private peers = new Map<string, Peer>();
  private assembler = new CallPartAssembler();
  private listeners = new Listeners();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopRooms: (() => void) | null = null;
  private started = false;
  private left = false;
  private only: string | null;
  /** The other person of a private room has been in it, listed or by an offer. */
  private personArrived = false;
  private sentPeers = 0;

  constructor(opts: {
    circleKey: string;
    room: string;
    me: string;
    transport: CallTransport;
    rooms: CallRooms;
    newPeer: PeerFactory;
    session?: string;
    /** A private room: state goes only to this identity, and nobody else in the room is joined. */
    with?: string;
    /** Told when a connection connects and when a connected one ends. */
    report?: (report: LinkReport) => void;
  }) {
    this.circleKey = opts.circleKey;
    this.room = opts.room;
    this.me = opts.me;
    this.transport = opts.transport;
    this.rooms = opts.rooms;
    this.newPeer = opts.newPeer;
    this.only = opts.with ?? null;
    this.report = opts.report ?? (() => undefined);
    this.session = opts.session ?? randomSession();
  }

  get participants(): CallParticipant[] {
    return [...this.peers.values()].map(({ key, identity, s, muted, camera, device, state, remote }) => ({
      key,
      identity,
      s,
      muted,
      camera,
      ...(device ? { device } : {}),
      state,
      remote,
    }));
  }

  start(): void {
    if (this.started || this.left) return;
    this.started = true;
    this.stopRooms = this.rooms.onChange(() => this.sync());
    this.announce();
    this.timer = setInterval(() => {
      this.announce();
      this.rooms.expire(Date.now());
    }, CALL_STATE_EVERY_MS);
    this.sync();
  }

  setMuted(on: boolean): void {
    if (this.muted === on) return;
    this.muted = on;
    if (this.started && !this.left) this.announce();
    this.changed();
  }

  setCamera(on: boolean): void {
    if (this.camera === on) return;
    this.camera = on;
    if (this.started && !this.left) this.announce();
    this.changed();
  }

  /**
   * Start over with one person: this side offers, whichever session id is smaller. If both sides
   * retry at once, the smaller session's offer wins and the other answers it.
   */
  retry(key: string): void {
    const peer = this.peers.get(key);
    if (!peer || this.left) return;
    this.reset(peer);
    peer.state = 'connecting';
    this.changed();
    void this.offer(peer);
  }

  leave(): void {
    if (this.left) return;
    this.left = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopRooms?.();
    for (const peer of this.peers.values()) {
      void this.send(peer.identity, { t: 'bye', room: this.room, s: this.session, to: peer.s });
      this.reset(peer);
    }
    this.peers.clear();
    if (this.started) {
      const state: CallState = { ...this.state(), left: true };
      this.sendState(state);
      this.rooms.see(this.circleKey, this.me, state, Date.now());
    }
    this.changed();
  }

  async receivePart(from: string, part: CallPart): Promise<void> {
    if (this.left || from === this.me || (this.only && from !== this.only) || !isCallPart(part)) return;
    const message = cleanCallMessage(await this.assembler.add(from, part));
    if (!message || this.left || message.to !== this.session || message.room !== this.room) return;
    const key = `${from}/${message.s}`;
    if (message.t === 'bye') {
      const peer = this.peers.get(key);
      if (!peer) return;
      this.reset(peer);
      this.peers.delete(key);
      this.changed();
      return;
    }
    if (message.t === 'offer') {
      await this.answer(from, message);
      return;
    }
    const peer = this.peers.get(key);
    if (!peer?.link || peer.state === 'unreachable') return;
    if (!peer.offering) return;
    const { link, attempt } = peer;
    peer.offering = false;
    this.clearTimer(peer);
    try {
      await link.accept(message.sdp);
      if (peer.attempt !== attempt) return;
      if (peer.tunnel?.port) await link.addTunnel(peer.tunnel.port);
    } catch {
      if (peer.attempt === attempt) this.unreachable(peer);
      return;
    }
    if (peer.attempt === attempt && peer.state === 'connecting') this.waitFor(peer, CALL_CONNECT_MS);
  }

  onChange(listener: () => void): () => void {
    return this.listeners.add(listener);
  }

  private state(): CallState {
    return { room: this.room, s: this.session, muted: this.muted, camera: this.camera, peers: this.connectedCount() };
  }

  private connectedCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.state === 'connected') count++;
    return count;
  }

  private sendState(state: CallState): void {
    this.sentPeers = state.peers ?? 0;
    if (this.only) this.transport.sendState(this.circleKey, state, this.only);
    else this.transport.sendState(this.circleKey, state);
  }

  private announce(): void {
    const state = this.state();
    this.sendState(state);
    this.rooms.see(this.circleKey, this.me, state, Date.now());
  }

  /** Match the peers to who `call.state` says is in the room. */
  private sync(): void {
    if (this.left) return;
    const people = this.rooms
      .people(this.circleKey, this.room)
      .filter((person) => person.identity !== this.me && (!this.only || person.identity === this.only));
    const present = new Set(people.map((person) => `${person.identity}/${person.s}`));
    let changed = false;
    for (const [key, peer] of this.peers) {
      if (present.has(key) || !peer.listed) continue;
      this.reset(peer);
      this.peers.delete(key);
      changed = true;
    }
    for (const person of people) {
      const key = `${person.identity}/${person.s}`;
      const known = this.peers.get(key);
      if (known) {
        if (!known.listed || known.muted !== person.muted || known.camera !== person.camera || known.device !== person.device) changed = true;
        known.listed = true;
        known.device = person.device;
        known.muted = person.muted;
        known.camera = person.camera;
        continue;
      }
      const peer = this.addPeer(person, true);
      changed = true;
      if (this.session < person.s) void this.offer(peer);
      else this.waitFor(peer, CALL_ANSWER_MS);
    }
    if (changed) this.changed();
  }

  private addPeer(person: RoomPerson, listed: boolean): Peer {
    const peer: Peer = {
      key: `${person.identity}/${person.s}`,
      identity: person.identity,
      s: person.s,
      muted: person.muted,
      camera: person.camera,
      device: person.device,
      state: 'connecting',
      remote: null,
      link: null,
      tunnel: null,
      timer: null,
      listed,
      attempt: 0,
      offering: false,
      linkStarted: 0,
      linkRole: 'offer',
      connectedAt: null,
    };
    this.peers.set(peer.key, peer);
    if (this.only && peer.identity === this.only) this.personArrived = true;
    if (!listed) {
      // Known only from its offer: drop it if `call.state` never lists it.
      setTimeout(() => {
        if (this.peers.get(peer.key) !== peer || peer.listed) return;
        this.reset(peer);
        this.peers.delete(peer.key);
        this.changed();
      }, CALL_GONE_MS);
    }
    return peer;
  }

  private async offer(peer: Peer): Promise<void> {
    const attempt = ++peer.attempt;
    const link = this.attach(peer, 'offer');
    peer.offering = true;
    const id = randomTunnelId();
    const device = peer.device;
    const port = await this.transport.tunnel('open', this.circleKey, peer.identity, id, device).catch((): null => null);
    if (peer.attempt !== attempt || this.left) {
      if (port) void this.transport.tunnel('close', this.circleKey, peer.identity, id, device).catch((): null => null);
      return;
    }
    if (port) peer.tunnel = { id, port, ...(device ? { device } : {}) };
    this.waitFor(peer, CALL_ANSWER_MS);
    try {
      const sdp = await link.offer();
      if (peer.attempt !== attempt || this.left) return;
      await this.send(peer.identity, {
        t: 'offer',
        room: this.room,
        s: this.session,
        to: peer.s,
        sdp,
        ...(port ? { tunnel: id } : {}),
      }, () => peer.attempt === attempt && !this.left);
    } catch {
      if (peer.attempt === attempt) this.unreachable(peer);
    }
  }

  private async answer(from: string, message: Extract<CallMessage, { t: 'offer' }>): Promise<void> {
    const key = `${from}/${message.s}`;
    const known = this.peers.get(key);
    // Both sides offered at once (both pressed Try again): the smaller session keeps its own offer.
    if (known?.offering && this.session < message.s) return;
    const peer =
      known ??
      this.addPeer(
        { identity: from, s: message.s, muted: false, camera: false, device: this.deviceInRoom(from, message.s) },
        false
      );
    this.reset(peer);
    peer.state = 'connecting';
    const attempt = ++peer.attempt;
    const link = this.attach(peer, 'answer');
    this.changed();
    let port: number | null = null;
    if (message.tunnel !== undefined) {
      const device = peer.device;
      port = await this.transport.tunnel('open', this.circleKey, from, message.tunnel, device).catch((): null => null);
      if (peer.attempt !== attempt || this.left) {
        if (port) void this.transport.tunnel('close', this.circleKey, from, message.tunnel, device).catch((): null => null);
        return;
      }
      if (port) peer.tunnel = { id: message.tunnel, port, ...(device ? { device } : {}) };
    }
    try {
      const sdp = await link.answer(message.sdp);
      if (peer.attempt !== attempt || this.left) return;
      if (port) await link.addTunnel(port);
      if (peer.attempt !== attempt || this.left) return;
      await this.send(
        from,
        { t: 'answer', room: this.room, s: this.session, to: message.s, sdp },
        () => peer.attempt === attempt && !this.left
      );
    } catch {
      if (peer.attempt === attempt) this.unreachable(peer);
      return;
    }
    if (peer.attempt === attempt && peer.state === 'connecting') this.waitFor(peer, CALL_CONNECT_MS);
  }

  /** The device that sent `call.state` for this session, if the room has seen it. */
  private deviceInRoom(identity: string, s: string): string | undefined {
    return this.rooms.people(this.circleKey, this.room).find((person) => person.identity === identity && person.s === s)?.device;
  }

  /** A fresh link for `peer`, wired to its state. */
  private attach(peer: Peer, role: 'offer' | 'answer'): PeerLink {
    const link = this.newPeer();
    peer.link = link;
    peer.remote = link.remote;
    peer.linkStarted = Date.now();
    peer.linkRole = role;
    peer.connectedAt = null;
    link.onState((state) => {
      if (peer.link !== link || this.left) return;
      if (state === 'connected') {
        this.clearTimer(peer);
        if (peer.connectedAt === null) {
          peer.connectedAt = Date.now();
          this.report({
            kind: 'connected',
            key: peer.key,
            identity: peer.identity,
            role: peer.linkRole,
            ms: peer.connectedAt - peer.linkStarted,
            link,
          });
        }
        if (peer.state !== 'connected') {
          peer.state = 'connected';
          this.changed();
        }
      } else if (state === 'failed') {
        this.unreachable(peer);
      }
    });
    return link;
  }

  private waitFor(peer: Peer, ms: number): void {
    this.clearTimer(peer);
    const attempt = peer.attempt;
    peer.timer = setTimeout(() => {
      peer.timer = null;
      if (peer.attempt === attempt && peer.state === 'connecting' && this.peers.get(peer.key) === peer) this.unreachable(peer);
    }, ms);
  }

  private clearTimer(peer: Peer): void {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
  }

  private unreachable(peer: Peer): void {
    this.reset(peer);
    peer.state = 'unreachable';
    this.changed();
  }

  /** Close the link and tunnel and stop any timer; later async steps of this attempt are ignored. */
  private reset(peer: Peer): void {
    peer.attempt++;
    peer.offering = false;
    this.clearTimer(peer);
    if (peer.link && peer.connectedAt !== null) {
      const seconds = Math.round((Date.now() - peer.connectedAt) / 1000);
      this.report({ kind: 'ended', key: peer.key, identity: peer.identity, seconds, link: peer.link });
    }
    peer.connectedAt = null;
    peer.link?.close();
    peer.link = null;
    peer.remote = null;
    if (peer.tunnel) {
      const { id, device } = peer.tunnel;
      void this.transport.tunnel('close', this.circleKey, peer.identity, id, device).catch((): null => null);
    }
    peer.tunnel = null;
  }

  /** Send a message in parts; stops between parts once `live` says the attempt is over. */
  private async send(to: string, message: CallMessage, live: () => boolean = () => true): Promise<void> {
    const packed = await packCallMessage(message);
    for (const part of packed.parts) {
      if (!live()) return;
      await this.transport.sendPart(this.circleKey, to, part);
    }
  }

  private changed(): void {
    if (this.only && this.personArrived && !this.over && !this.left && this.peers.size === 0) {
      this.over = true;
      this.leave();
      return;
    }
    if (this.started && !this.left && this.connectedCount() !== this.sentPeers) this.announce();
    this.listeners.emit();
  }
}
