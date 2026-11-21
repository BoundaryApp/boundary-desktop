/**
 * The Circles runtime inside the network utilityProcess (ADR 0032). It holds one Corestore and one
 * Hyperswarm, and opens an Autobase for each Circle in its own Corestore namespace. Main hands it
 * the user's seeds and each Circle's secrets, and keeps them; this side keeps blocks and the list of removed devices (`removed-devices.json`).
 *
 * Replication is limited to known people: a connection replicates only when its device is a
 * member of one of this user's Circles, or while a Circle is still joining and knows no one yet.
 * A device removed from every Circle shared with this user is disconnected.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Autobase from 'autobase';
import BlindPairing, { type BlindMember, type BlindCandidate } from 'blind-pairing';
import Corestore from 'corestore';
import crypto from 'hypercore-crypto';
import Hyperbee from 'hyperbee';
import Hyperswarm, { type SecretStream } from 'hyperswarm';
import z32 from 'z32';
import {
  ChatScan,
  channelUnread,
  chatChannels,
  findChatMessage,
  readChatMessages,
  type ChatReader,
} from './circleChat';
import { REPLIES_FORMAT } from '../../../shared/circleReplies';
import { isReactionEmoji, MAX_REACTIONS_PER_MESSAGE, REACTIONS_APP } from '../../../shared/circleReactions';
import {
  changedReactionRefs,
  indexReactions,
  parseReactionRecord,
  reactionRecordKey,
  type ReactionIndex,
  type ReactionRecordValue,
} from './circleReactions';
import {
  applyCircleNodes,
  CHAT_FORMAT,
  chatPostProblem,
  CIRCLE_FORMAT,
  CIRCLE_KEY,
  cleanMentions,
  deviceProofMessage,
  INVITES_PREFIX,
  introIsValid,
  inviteKey,
  isRecordName,
  isRecordScope,
  isMessageId,
  isMessageText,
  isRecordValue,
  lostMembership,
  memberRecordKey,
  MEMBERS_PREFIX,
  MENTIONS_FORMAT,
  OFFERS_PREFIX,
  RECORDS_PREFIX,
  type CircleHeader,
  type CircleInviteRecord,
  type CircleMemberIntro,
  type CircleMemberRecord,
  type CircleMessageMentions,
  type CircleMessageShared,
  type CircleOffer,
  type CircleOfferRecord,
  type CircleOp,
  type CircleRecord,
  type CircleRecordScope,
  type CircleRole,
} from './circleOps';
import { parseServiceOffer, SERVICES_APP } from '../../../shared/serviceOffers';
import { addressClass } from './addressClass';
import { beeView } from './autobaseApply';
import { CallTunnels, tunnelSample, type CallTunnelStats } from './callTunnel';

import { decodeSignal, encodeSignal, SignalStats, type CircleSignal } from './circleSignals';
import type {
  CircleChannel,
  CircleChatUpdate,
  CircleDayUsage,
  CircleLimits,
  CircleMessage,
  CircleMessageRef,
  CircleReadPosition,
  CircleServing,
} from '../../../shared/types/circles';
import { INFERENCE_LINK, type InferenceLink, type SharedModelResponse } from './inferenceChannel';
import { GatewayLink, onLinkOpen, type LinkGateway, type LinkSpec } from './gatewayLink';
import { InferenceGateway, type GatewayRequest, type GatewayUpstream } from './inferenceGateway';
import type {
  CirclePublicAddress,
  CircleRecordChange,
  CircleRecordEntry,
  CircleSecrets,
  CircleSnapshot,
  CallContext,
  CirclesSnapshot,
  ServiceSharing,
  SharedModelCall,
} from './networkMessages';
import { RemovalLink } from './removalNotice';
import { SharedFolders } from './sharedFolders';
import { SERVICE_LINK, type ServiceLink } from './serviceChannel';
import { ServiceGateway, type ServiceGrantKeys, type ServiceRequest, type ServiceUpstream } from './serviceGateway';
import { onSignalOpen, SignalLink } from './signalChannel';

/** How often tunnels are sampled while open. */
const TUNNEL_SAMPLE_MS = 5_000;

export interface CircleNetworkOptions {
  storageDir: string;
  identitySeed: Buffer;
  deviceSeed: Buffer;
  /** The name other members see. */
  name: string;
  /** DHT bootstrap nodes as `host:port`; Hyperswarm's public ones when omitted. */
  bootstrap?: string[];
  /** How often an admin's device acks, in ms. Autobase debounces it, so confirmation takes longer. */
  ackInterval?: number;
  /** Stands in for a build with a different `CIRCLE_FORMAT`, in tests. */
  supportedFormat?: number;
  /** What members have used of this user's models today. */
  usage?: CircleDayUsage;
  onUsage?: (served: CircleDayUsage | undefined, serving: CircleServing) => void;
  /** What members have used of this user's services today. */
  serviceUsage?: CircleDayUsage;
  onServiceUsage?: (served: CircleDayUsage) => void;
  /** Called whenever what `snapshot()` returns may have changed. */
  onChange?: () => void;
  /** A peer signal on a topic passed to `setSignalTopics`, from a current member of its Circle. */
  onSignal?: (signal: CircleSignal) => void;
  /** A record of an app passed to `setRecordApps` changed. */
  onRecord?: (change: CircleRecordChange) => void;
  /** Messages in one channel of a Circle were added, changed or settled away. */
  onChat?: (update: CircleChatUpdate) => void;
  /** An admin admitted this device. Main keeps the secrets now: the Circle opens from here on. */
  onPaired?: (secrets: CircleSecrets) => void;
  /**
   * This device was removed from a Circle, or its leave was confirmed, and it has closed the
   * Circle. Main forgets its secrets.
   */
  onRemoved?: (key: string) => void;
  /** As an admin, this device saw a member leave a Circle. */
  onMemberLeft?: (left: { key: string; circle: string; name: string }) => void;
  /** A shared folder's view may have changed (ADR 0049). */
  onFolderChange?: (key: string) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /**
   * Diagnostics events for a test run (metadata only: key prefixes, counts, timings, address
   * classes; never names, codes, keys, prompts or replies).
   */
  diag?: (event: string, data: Record<string, unknown>) => void;
}

const short = (key: string | null | undefined): string | null => (key ? key.slice(0, 8) : null);
const grantKey = (circle: string, service: string, identity: string): string => `${circle}/${service}/${identity}`;

/** How often a Circle's work ran, to show work that repeats without changing anything. */
interface CircleCounts {
  /** Autobase `update` events. */
  updates: number;
  /** Re-reads of the view (refreshCircle). */
  refreshes: number;
  /** Record and chat scans that finished. */
  scans: number;
  /** Scans waiting behind the one running. */
  scansQueued: number;
  /** Calls to apply, and the nodes they were given. Autobase reapplies unconfirmed nodes. */
  applies: number;
  appliedNodes: number;
}

interface OpenCircle {
  secrets: CircleSecrets;
  base: Autobase<Hyperbee>;
  view: Hyperbee;
  member: BlindMember | null;
  /** Read from the view after each update. */
  state: {
    name: string;
    format: number;
    members: CircleMemberRecord[];
    invites: CircleInviteRecord[];
    offers: CircleOfferRecord[];
  };
  /** Autobase stopped applying at a format this build can't apply. */
  needsUpdate: boolean;
  /** Each record seen by the last scan, by view key, to tell what changed. */
  records: Map<string, CircleRecordEntry>;
  /** Reactions from `records`. */
  reactions: ReactionIndex;
  /** Messages whose reactions changed since the last chat scan; the next one reports them. */
  changedReactions: { channel: string; author: string; id: string }[];
  /** Follows the chat across updates. */
  chat: ChatScan;
  /** The scan in progress; scans run one at a time. */
  scan: Promise<void>;
  /** The last state written to diagnostics, to log changes only. */
  lastDiag: string;
  /** Running totals since the Circle opened, for the heartbeat. */
  counts: CircleCounts;
  /** Leaving or being removed: this device's own removal closes the Circle only once. */
  closing: boolean;
  /**
   * This user left, and the Circle stays open, out of the snapshot, until an admin confirms it.
   * Until then the removal is only in this device's log, so it has to stay online to send it.
   */
  leaving: boolean;
  /** Whether each removal `apply` saw was the member leaving, by identity. */
  departures: Map<string, boolean>;
}

const LAST_ADMIN = 'The last admin can’t leave. Make someone else an admin first.';

/** How long a removed device stays connected, for its notice to go out first. */
const REMOVAL_NOTICE_MS = 2_000;
/** How long a join waits to become a writer. A member can read and be served without it. */
const JOIN_WRITABLE_MS = 60_000;

const STATUS_REJECTED = 1;
const STATUS_USED = 2;
const STATUS_EXPIRED = 3;

/** Values under a key prefix of a Hyperbee. */
async function listPrefix(bee: Hyperbee, prefix: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const entry of bee.createReadStream({ gte: prefix, lt: `${prefix}\xff` })) values.push(entry.value);
  return values;
}

/** Thrown when a post carries a reply to a Circle still on an older format. */
const REPLIES_NEED_UPDATE = 'Replies need this Circle to be updated first.';

/** Thrown when a post or edit carries mentions to a Circle still on an older format. */
const MENTIONS_NEED_UPDATE = 'Mentions need this Circle updated.';

/** A connected device, as `CircleNetwork.peers` keeps it. */
interface Peer {
  connection: SecretStream;
  replicating: boolean;
  inference: InferenceLink | null;
  services: ServiceLink | null;
  signals: SignalLink | null;
  removal: RemovalLink | null;
  /** Circles this connection has been told it was removed from. */
  noticed: Set<string>;
  dropTimer: NodeJS.Timeout | null;
  connectedAt: number;
}

/**
 * One kind of gateway link a peer can have: its spec, this side's gateway, and the peer's slot
 * for it. Diagnostics events take their prefixes from `spec.events`.
 */
interface LinkKind<R extends { id: number; circle: string }> {
  spec: LinkSpec<R>;
  gateway: LinkGateway<R>;
  get(peer: Peer): GatewayLink<R> | null;
  set(peer: Peer, link: GatewayLink<R> | null): void;
}

export class CircleNetwork {
  readonly identity: { publicKey: Buffer; secretKey: Buffer };
  readonly device: { publicKey: Buffer; secretKey: Buffer };
  /** Shared folders, which replicate over this network's connections (ADR 0049 §2). */
  readonly folders: SharedFolders;
  private readonly store: Corestore;
  private readonly swarm: Hyperswarm;
  private readonly pairing: BlindPairing;
  private readonly circles = new Map<string, OpenCircle>();
  /** Per-Circle tail of queued reaction toggles; see reactMessage. */
  private readonly reactQueues = new Map<string, Promise<void>>();
  /**
   * Connected devices, by device key: whether this side is replicating with each, and the
   * inference, service, signal and removal channels, which open alongside replication.
   */
  private readonly peers = new Map<string, Peer>();
  /** Devices removed from each Circle, by Circle key, kept so one offline then hears on return. */
  private readonly removedDevices: Map<string, Set<string>>;
  private readonly gateway: InferenceGateway;
  /** This user's model server, when they share; main sets it. */
  private shareUpstream: GatewayUpstream | null = null;
  private readonly serviceGateway: ServiceGateway;
  /** The inference link (ADR 0034 §2) and the service link (ADR 0048 §1), which work alike. */
  private readonly inferenceLink: LinkKind<GatewayRequest>;
  private readonly serviceLink: LinkKind<ServiceRequest>;
  /** Members' keys for this user's services, by `circle/service/identity`; main sets them. */
  private serviceGrants = new Map<string, ServiceGrantKeys>();
  private serviceUpstreams = new Map<string, ServiceUpstream>();
  private stopJoin: (() => void) | null = null;
  /** The signal topics main listens to; others are dropped here and never cross to main. */
  private signalTopics = new Set<string>();
  private recordApps = new Set<string>();
  private readonly signalStats = new SignalStats();
  /** Call packets carried over peer connections, for the call check's tunnel modes. */
  private readonly tunnels = new CallTunnels();
  /** Samples tunnels and the process every few seconds while any tunnel is open. */
  private tunnelSampler: NodeJS.Timeout | null = null;
  private name: string;
  private closed = false;

  constructor(private readonly options: CircleNetworkOptions) {
    this.identity = crypto.keyPair(options.identitySeed);
    this.device = crypto.keyPair(options.deviceSeed);
    this.name = options.name;
    this.store = new Corestore(path.join(options.storageDir, 'corestore'));
    this.removedDevices = this.loadRemovedDevices();
    this.swarm = new Hyperswarm({
      keyPair: this.device,
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    });
    this.swarm.on('connection', (connection, peer) => this.onConnection(connection, peer.publicKey));
    this.pairing = new BlindPairing(this.swarm);
    const dht = this.swarm.dht;
    dht.on('nat-update', () => this.diag('dht.nat-update', this.dhtState()));
    dht.on('network-change', () => this.diag('dht.network-change', this.dhtState()));
    dht.on('persistent', () => this.diag('dht.persistent', this.dhtState()));
    this.gateway = new InferenceGateway({
      diag: (event, data) => this.diag(event, data),
      offerFor: (key) => this.liveCircle(key)?.state.offers.find((offer) => offer.identity === this.identityHex) ?? null,
      memberFor: (key, device) => this.memberOfDevice(key, device),
      upstream: () => this.shareUpstream,
      log: (message, data) => this.log(message, data),
      usage: options.usage,
      onUsage: options.onUsage,
    });
    this.folders = new SharedFolders({
      store: this.store,
      identity: this.identity,
      device: this.device,
      name: () => this.name,
      ackInterval: options.ackInterval,
      onChange: (key) => options.onFolderChange?.(key),
      log: (message, data) => this.log(message, data),
    });
    this.serviceGateway = new ServiceGateway({
      diag: (event, data) => this.diag(event, data),
      memberFor: (key, device) => this.memberOfDevice(key, device),
      offerFor: (key, service) => this.myServiceOffer(key, service),
      grantFor: (key, service, identity) => this.serviceGrants.get(grantKey(key, service, identity)) ?? null,
      upstream: (service) => this.serviceUpstreams.get(service) ?? null,
      log: (message, data) => this.log(message, data),
      usage: options.serviceUsage,
      onUsage: (served) => options.onServiceUsage?.(served),
    });
    this.inferenceLink = {
      spec: INFERENCE_LINK,
      gateway: this.gateway,
      get: (peer) => peer.inference,
      set: (peer, link) => {
        peer.inference = link;
      },
    };
    this.serviceLink = {
      spec: SERVICE_LINK,
      gateway: this.serviceGateway,
      get: (peer) => peer.services,
      set: (peer, link) => {
        peer.services = link;
      },
    };
  }

  async ready(): Promise<void> {
    await this.store.ready();
    this.diag('net.ready', {
      identity: short(this.identityHex),
      device: short(this.device.publicKey.toString('hex')),
      customBootstrap: Boolean(this.options.bootstrap),
    });
  }

  private diag(event: string, data: Record<string, unknown> = {}): void {
    this.options.diag?.(event, data);
  }

  /** This device's address as the DHT sees it. Main passes it only to the renderer, never to a log. */
  publicAddress(): CirclePublicAddress {
    const dht = this.swarm.dht;
    return { host: dht.host, port: dht.port, firewalled: dht.firewalled, randomizedNat: dht.randomized };
  }

  private dhtState(): Record<string, unknown> {
    const dht = this.swarm.dht;
    return {
      addr: addressClass(dht.host),
      firewalled: dht.firewalled,
      randomizedNat: dht.randomized,
      ephemeral: dht.ephemeral,
    };
  }

  /** The circles a device belongs to here, by key prefix. */
  private circlesOf(device: string): string[] {
    return [...this.circles.values()]
      .filter((circle) => circle.state.members.some((member) => member.device === device))
      .map((circle) => short(circle.secrets.key)!);
  }

  /**
   * A summary for the periodic health record: peers, each Circle's members, offers and
   * confirmation, the gateway's queue and the DHT's view of this network.
   */
  diagnostics(): Record<string, unknown> {
    const online = new Set(this.peers.keys());
    return {
      dht: this.dhtState(),
      peers: [...this.peers.entries()].map(([device, peer]) => ({
        device: short(device),
        replicating: peer.replicating,
        link: peer.inference ? (peer.inference.closed ? 'closed' : 'open') : null,
        ageS: Math.round((Date.now() - peer.connectedAt) / 1000),
        rttMs: peer.connection.rawStream?.rtt ?? null,
        addr: addressClass(peer.connection.rawStream?.remoteHost),
      })),
      circles: [...this.circles.values()].map((circle) => ({
        circle: short(circle.secrets.key),
        members: circle.state.members.length,
        online: circle.state.members.filter((member) => online.has(member.device)).length,
        offers: circle.state.offers.map((offer) => ({
          provider: short(offer.identity),
          models: offer.models.length,
          available: offer.available,
          online: offer.identity === this.identityHex || circle.state.members.some((m) => m.identity === offer.identity && online.has(m.device)),
        })),
        viewLength: circle.view.core.length,
        signedLength: circle.view.core.signedLength,
        indexers: circle.base.system?.indexers.length ?? 0,
        isIndexer: circle.base.isIndexer,
        counts: { ...circle.counts },
      })),
      gateway: this.gateway.stats(),
      serviceGateway: { ...this.serviceGateway.stats(), services: this.serviceUpstreams.size, grants: this.serviceGrants.size },
      sharing: Boolean(this.shareUpstream),
      signals: this.signalStats.summary(),
    };
  }

  private log(message: string, data?: Record<string, unknown>): void {
    this.options.log?.(message, data);
  }

  private changed(): void {
    if (!this.closed) this.options.onChange?.();
  }

  // ---- Peers ---------------------------------------------------------------------------------

  private onConnection(connection: SecretStream, remoteKey: Buffer): void {
    const device = remoteKey.toString('hex');
    const connectedAt = Date.now();
    const replaced = this.peers.has(device);
    const removal = RemovalLink.attach(connection, (circleKey) => this.onRemovalNotice(device, circleKey));
    this.peers.set(device, {
      connection,
      replicating: false,
      inference: null,
      services: null,
      signals: null,
      removal,
      noticed: new Set(),
      dropTimer: null,
      connectedAt,
    });
    this.diag('peer.connect', {
      device: short(device),
      initiator: connection.isInitiator,
      addr: addressClass(connection.rawStream?.remoteHost),
      circles: this.circlesOf(device),
      replaced,
      peers: this.peers.size,
    });
    for (const kind of [this.inferenceLink, this.serviceLink] as const) {
      onLinkOpen(connection, kind.spec.protocol, () => this.attachLink(kind, device, 'remote'));
    }
    onSignalOpen(connection, () => this.attachSignals(device));
    this.tunnels.attach(device, connection);
    connection.on('error', (err: unknown) => {
      this.log('peer connection error', { error: String(err) });
      const code = (err as { code?: string } | null)?.code;
      this.diag('peer.error', { device: short(device), error: code ?? (err instanceof Error ? err.name : typeof err) });
    });
    connection.once('close', () => {
      const raw = connection.rawStream;
      this.diag('peer.close', {
        device: short(device),
        ms: Date.now() - connectedAt,
        rttMs: raw?.rtt ?? null,
        bytesOut: raw?.bytesTransmitted ?? null,
        bytesIn: raw?.bytesReceived ?? null,
        packetsOut: raw?.packetsTransmitted ?? null,
        packetsIn: raw?.packetsReceived ?? null,
        retransmits: raw?.retransmits ?? null,
        current: this.peers.get(device)?.connection === connection,
      });
      const current = this.peers.get(device);
      if (current?.connection === connection) {
        if (current.dropTimer) clearTimeout(current.dropTimer);
        this.peers.delete(device);
      }
      this.changed();
    });
    this.refreshPeers();
    this.changed();
  }

  /** Every device that is a member of one of this user's Circles. */
  private knownDevices(): Set<string> {
    const devices = new Set<string>();
    for (const circle of this.circles.values()) {
      for (const member of circle.state.members) devices.add(member.device);
    }
    return devices;
  }

  /** Replicate with known devices (and anyone while joining); drop devices no Circle knows. */
  private refreshPeers(): void {
    const known = this.knownDevices();
    const joining = [...this.circles.values()].some((circle) => circle.state.members.length === 0);
    for (const [device, peer] of this.peers) {
      const notified = this.sendRemovalNotices(device, peer);
      if (known.has(device) || joining) {
        if (!peer.replicating) {
          peer.replicating = true;
          this.store.replicate(peer.connection);
          this.diag('peer.replicate', { device: short(device), known: known.has(device), joining });
        }
        this.attachLink(this.inferenceLink, device, 'local');
        this.attachLink(this.serviceLink, device, 'local');
        this.attachSignals(device);
      } else if (peer.replicating) {
        // It was replicating, so it was known: it has since been removed everywhere we meet.
        this.log('dropping a removed device', { device: device.slice(0, 12) });
        this.diag('peer.drop-removed', { device: short(device), notified });
        if (!notified) peer.connection.destroy();
        else if (!peer.dropTimer) {
          peer.dropTimer = setTimeout(() => peer.connection.destroy(), REMOVAL_NOTICE_MS);
          peer.dropTimer.unref();
        }
      }
    }
  }

  /** As an admin, tell a connected device about each Circle it was removed from. */
  private sendRemovalNotices(device: string, peer: { removal: RemovalLink | null; noticed: Set<string> }): boolean {
    for (const [key, devices] of this.removedDevices) {
      if (!devices.has(device) || peer.noticed.has(key)) continue;
      const circle = this.circles.get(key);
      const me = circle?.state.members.find((member) => member.identity === this.identityHex);
      if (me?.role !== 'admin' || !peer.removal) continue;
      peer.noticed.add(key);
      const sent = peer.removal.send(Buffer.from(key, 'hex'));
      this.diag(sent ? 'removal.notice-sent' : 'removal.notice-dropped', { circle: short(key), device: short(device) });
    }
    return peer.noticed.size > 0;
  }

  /** An admin says this device was removed. The connection names the sender; a frame can't. */
  private onRemovalNotice(device: string, circleKey: Buffer): void {
    const circle = this.circles.get(circleKey.toString('hex'));
    if (!circle) return;
    const sender = circle.state.members.find((member) => member.device === device);
    if (sender?.role !== 'admin') {
      this.diag('removal.notice-ignored', { circle: short(circle.secrets.key), device: short(device) });
      return;
    }
    this.closeRemovedCircle(circle);
  }

  private closeRemovedCircle(circle: OpenCircle): void {
    if (circle.closing) return;
    circle.closing = true;
    const key = circle.secrets.key!;
    this.diag(circle.leaving ? 'circle.left' : 'circle.removed-here', { circle: short(key) });
    // Called from inside Autobase's update, so the close waits for that turn to finish.
    setImmediate(() => {
      this.closeCircle(circle)
        .then(() => this.options.onRemoved?.(key))
        .catch((err: unknown) => this.log('closing a removed Circle failed', { error: String(err) }));
    });
  }

  private removedDevicesFile(): string {
    return path.join(this.options.storageDir, 'removed-devices.json');
  }

  private loadRemovedDevices(): Map<string, Set<string>> {
    try {
      const stored = JSON.parse(readFileSync(this.removedDevicesFile(), 'utf8')) as Record<string, string[]>;
      return new Map(Object.entries(stored).map(([key, devices]) => [key, new Set(devices)]));
    } catch {
      return new Map();
    }
  }

  /** Note who left the member list. A device that joins again comes off it. */
  private trackRemovedDevices(key: string, before: CircleMemberRecord[], after: CircleMemberRecord[]): void {
    const removed = this.removedDevices.get(key) ?? new Set<string>();
    const identities = new Set(after.map((member) => member.identity));
    const size = removed.size;
    let changed = false;
    for (const member of before) {
      if (!identities.has(member.identity)) removed.add(member.device);
    }
    for (const member of after) changed = removed.delete(member.device) || changed;
    if (!changed && removed.size === size) return;
    this.removedDevices.set(key, removed);
    this.saveRemovedDevices();
  }

  private dropRemovedDevices(key: string): void {
    if (this.removedDevices.delete(key)) this.saveRemovedDevices();
  }

  private saveRemovedDevices(): void {
    const stored = Object.fromEntries([...this.removedDevices].map(([circle, devices]) => [circle, [...devices]]));
    writeFileSync(this.removedDevicesFile(), JSON.stringify(stored));
  }

  /** Open a gateway link of `kind` with a known device, unless it is already open. */
  private attachLink<R extends { id: number; circle: string }>(kind: LinkKind<R>, device: string, opener: 'local' | 'remote'): void {
    const event = kind.spec.events.link;
    const peer = this.peers.get(device);
    if (!peer?.replicating) {
      // A remote open from a device not known here is turned down by Protomux.
      if (opener === 'remote') this.diag(`${event}.refused-unknown`, { device: short(device), connected: Boolean(peer) });
      return;
    }
    const current = kind.get(peer);
    if (current && !current.closed) return;
    const link = GatewayLink.attach(
      kind.spec,
      peer.connection,
      device,
      kind.gateway,
      () => {
        if (kind.get(peer) === link) kind.set(peer, null);
      },
      (name, data) => this.diag(name, data)
    );
    if (link) this.diag(`${event}.attach`, { device: short(device), opener });
    kind.set(peer, link);
  }

  /** Who a device belongs to in a Circle this device has open, or null. */
  private memberOfDevice(key: string, device: string): string | null {
    return this.liveCircle(key)?.state.members.find((member) => member.device === device)?.identity ?? null;
  }

  /** This user's offer of `service` in a Circle, read from the Circle's records. */
  private myServiceOffer(key: string, service: string): { available: boolean } | null {
    const circle = this.liveCircle(key);
    if (!circle) return null;
    for (const record of circle.records.values()) {
      if (record.app !== SERVICES_APP || record.scope !== 'member' || record.key !== service) continue;
      if (record.identity !== this.identityHex) continue;
      const offer = parseServiceOffer(record.value);
      return offer ? { available: offer.available } : null;
    }
    return null;
  }

  /** Open the signal channel with a known device, unless it is already open. */
  private attachSignals(device: string): void {
    const peer = this.peers.get(device);
    if (!peer?.replicating || (peer.signals && !peer.signals.closed)) return;
    const link = SignalLink.attach(
      peer.connection,
      (raw) => this.onSignalFrame(device, raw),
      () => this.signalStats.onDropped('rate'),
      () => {
        if (peer.signals === link) peer.signals = null;
      }
    );
    peer.signals = link;
  }

  /**
   * A frame from a device. The sender is whoever that device is in the Circle the frame names,
   * so a member of one shared Circle can't reach, or speak in, another.
   */
  private onSignalFrame(device: string, raw: Buffer): void {
    const frame = decodeSignal(raw);
    if (!frame) return this.signalStats.onDropped('malformed');
    const sender = this.liveCircle(frame.circle)?.state.members.find((member) => member.device === device);
    if (!sender) return this.signalStats.onDropped('not-member');
    if (!this.signalTopics.has(frame.topic)) return this.signalStats.onDropped('unknown-topic');
    this.signalStats.onReceived(frame.topic, raw.length);
    this.options.onSignal?.({ ...frame, from: sender.identity, device });
  }

  /** The apps `onRecord` reports. Records of other apps still replicate and stay in the view. */
  setRecordApps(apps: string[]): void {
    this.recordApps = new Set(apps);
  }

  /** The topics to deliver through `onSignal`; replaces the previous list. */
  setSignalTopics(topics: string[]): void {
    this.signalTopics = new Set(topics);
  }

  /**
   * Send a signal to the Circle's connected members, or to one of them. Nothing is kept, so a
   * member who is offline misses it. Returns how many peers it went to.
   */
  sendSignal(key: string, topic: string, payload: unknown, toIdentity?: string): number {
    const circle = this.circle(key);
    const frame = encodeSignal({ circle: key, topic, payload });
    let sent = 0;
    for (const member of circle.state.members) {
      if (member.identity === this.identityHex || (toIdentity && member.identity !== toIdentity)) continue;
      if (this.peers.get(member.device)?.signals?.send(frame)) {
        sent += 1;
        this.signalStats.onSent(topic, frame.length);
      }
    }
    return sent;
  }

  /** Devices of one member of a Circle, other than this user. */
  private memberDevices(key: string, identity: string): string[] {
    if (identity === this.identityHex) throw new Error('That is you.');
    const devices = this.circle(key)
      .state.members.filter((member) => member.identity === identity)
      .map((member) => member.device);
    if (devices.length === 0) throw new Error('Not a member of that Circle.');
    return devices;
  }

  /**
   * Open a call tunnel to a member's connected device; resolves to the local UDP port. The
   * caller picks `id` and sends it in its offer, and the answerer opens the same id. With
   * `wanted`, the tunnel goes to that device, which must be one of the member's; without it, to
   * the first of the member's devices that is connected.
   */
  async openCallTunnel(key: string, identity: string, id: number, wanted?: string): Promise<number> {
    const devices = this.memberDevices(key, identity);
    if (wanted !== undefined && !devices.includes(wanted)) throw new Error("That device isn't theirs.");
    const device = wanted ?? devices.find((candidate) => this.peers.has(candidate));
    if (!device || !this.peers.has(device)) throw new Error('No connection to that member.');
    const port = await this.tunnels.open(device, id);
    this.diag('call.tunnel-open', { device: short(device), open: this.tunnels.count() });
    this.startTunnelSampler();
    return port;
  }

  /**
   * While tunnels are open, every `TUNNEL_SAMPLE_MS`: how late the timer fired, the process's CPU
   * and memory, and per peer the Circles connection and its tunnels' counts. Metadata only.
   */
  private startTunnelSampler(): void {
    if (this.tunnelSampler) return;
    let expected = Date.now() + TUNNEL_SAMPLE_MS;
    let cpu = process.cpuUsage();
    this.tunnelSampler = setInterval(() => {
      const peers = this.tunnels.summary();
      if (peers.length === 0) {
        if (this.tunnelSampler) clearInterval(this.tunnelSampler);
        this.tunnelSampler = null;
        return;
      }
      const now = Date.now();
      const used = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      this.diag('call.tunnel-sample', tunnelSample(peers, Math.max(0, now - expected), used, process.memoryUsage(), TUNNEL_SAMPLE_MS));
      expected = now + TUNNEL_SAMPLE_MS;
    }, TUNNEL_SAMPLE_MS);
    this.tunnelSampler.unref?.();
  }

  /** The DHT's view of this network and the Circles connection to one member, for a call check result. */
  callContext(key: string, identity: string): CallContext {
    const dht = this.swarm.dht;
    const device = this.memberDevices(key, identity).find((candidate) => this.peers.has(candidate));
    const peer = device ? this.peers.get(device) : undefined;
    const raw = peer?.connection.rawStream;
    return {
      natFirewalled: dht.firewalled,
      natRandomized: dht.randomized,
      peerConnected: Boolean(peer),
      ...(peer
        ? {
            peerAddr: addressClass(raw?.remoteHost),
            peerAgeS: Math.round((Date.now() - peer.connectedAt) / 1000),
            ...(raw ? { peerRttMs: raw.rtt, peerRetransmits: raw.retransmits, peerMtu: raw.mtu } : {}),
          }
        : {}),
    };
  }

  /** A tunnel's counts, and with `close` the final ones as it closes. Null when it's gone. */
  callTunnelStats(key: string, identity: string, id: number, { close = false } = {}): CallTunnelStats | null {
    const devices = new Set(this.memberDevices(key, identity));
    const device = this.tunnels.devicesWith(id).find((candidate) => devices.has(candidate));
    if (!device) return null;
    return close ? this.tunnels.close(device, id) : this.tunnels.stats(device, id);
  }

  // ---- Circles -------------------------------------------------------------------------------

  /** Open a Circle this device already belongs to, or one it was just confirmed into. */
  async openCircle(secrets: CircleSecrets): Promise<void> {
    if (this.circles.has(secrets.key ?? '')) return;
    const circle = await this.bootCircle(secrets);
    this.circles.set(circle.secrets.key!, circle);
    // A Circle still joining replicates with anyone, including peers already connected.
    this.refreshPeers();
    await this.joinTopic(circle);
  }

  private async bootCircle(secrets: CircleSecrets): Promise<OpenCircle> {
    const namespace = this.store.namespace(secrets.namespace);
    const departures = new Map<string, boolean>();
    const counts: CircleCounts = { updates: 0, refreshes: 0, scans: 0, scansQueued: 0, applies: 0, appliedNodes: 0 };
    const base = new Autobase(namespace, secrets.key ? Buffer.from(secrets.key, 'hex') : null, {
      encrypt: true,
      encryptionKey: secrets.encryptionKey ? Buffer.from(secrets.encryptionKey, 'hex') : undefined,
      ackInterval: this.options.ackInterval ?? 10_000,
      open: (viewStore) =>
        new Hyperbee(viewStore.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: (nodes, view, host) => {
        counts.applies++;
        counts.appliedNodes += nodes.length;
        return applyCircleNodes(nodes, beeView(view), host, {
          verify: (message, signature, publicKey) => crypto.verify(message, signature, publicKey),
          supportedFormat: this.supportedFormat,
          onSkip: (reason) => this.log('circle op skipped', { reason }),
          onRemoveMember: (identity, byThemselves) => departures.set(identity, byThemselves),
        });
      },
      valueEncoding: 'json',
    });
    await base.ready();
    const { leaving = false, ...kept } = secrets;
    const circle: OpenCircle = {
      secrets: {
        ...kept,
        key: base.key.toString('hex'),
        encryptionKey: base.encryptionKey!.toString('hex'),
      },
      base,
      view: base.view,
      member: null,
      state: { name: '', format: this.supportedFormat, members: [], invites: [], offers: [] },
      needsUpdate: false,
      records: new Map(),
      reactions: indexReactions([]),
      changedReactions: [],
      chat: new ChatScan(),
      scan: Promise.resolve(),
      lastDiag: '',
      counts,
      closing: false,
      leaving,
      departures,
    };
    base.on('update', () => {
      counts.updates++;
      void this.refreshCircle(circle);
    });
    base.on('writable', () => this.changed());
    base.on('unwritable', () => this.changed());
    base.on('interrupt', () => {
      circle.needsUpdate = true;
      this.diag('circle.needs-update', { circle: short(circle.secrets.key), supported: this.supportedFormat });
      this.changed();
    });
    base.on('error', (err: unknown) => {
      this.log('circle error', { error: String(err) });
      this.diag('circle.error', { circle: short(circle.secrets.key), error: err instanceof Error ? err.name : typeof err });
    });
    await this.refreshCircle(circle);
    return circle;
  }

  private async joinTopic(circle: OpenCircle): Promise<void> {
    const started = Date.now();
    const discovery = this.swarm.join(circle.base.discoveryKey, { server: true, client: true });
    await discovery.flushed();
    this.diag('circle.topic-flushed', { circle: short(circle.secrets.key), ms: Date.now() - started, ...this.dhtState() });
  }

  /** Re-read the view, start or stop admitting invitees, and refresh peers. */
  private async refreshCircle(circle: OpenCircle): Promise<void> {
    if (this.closed) return;
    circle.counts.refreshes++;
    const view = circle.view;
    const header = (await view.get(CIRCLE_KEY))?.value as CircleHeader | undefined;
    const before = circle.state.members;
    circle.state = {
      name: header?.name ?? circle.secrets.name ?? '',
      format: header?.format ?? circle.state.format,
      members: (await listPrefix(view, MEMBERS_PREFIX)) as CircleMemberRecord[],
      invites: (await listPrefix(view, INVITES_PREFIX)) as CircleInviteRecord[],
      offers: (await listPrefix(view, OFFERS_PREFIX)) as CircleOfferRecord[],
    };
    this.trackRemovedDevices(circle.secrets.key!, before, circle.state.members);
    if (circle.leaving) return this.refreshLeaving(circle);
    circle.counts.scansQueued++;
    circle.scan = circle.scan
      .then(() => {
        circle.counts.scansQueued--;
        return this.scanRecords(circle);
      })
      .then(() => this.scanChat(circle))
      .then(() => {
        circle.counts.scans++;
      });
    await circle.scan;
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    this.diagCircleState(circle, me?.role ?? null);
    this.reportDepartures(circle, before);
    // With a third member, the removal entry can reach this device by replication instead.
    if (lostMembership(before, circle.state.members, { identity: this.identityHex, writer: this.writerHex(circle) })) {
      this.closeRemovedCircle(circle);
      return;
    }
    // Only an admin's device admits invitees (ADR 0032 §5).
    if (me?.role === 'admin' && me.writer === this.writerHex(circle) && !circle.member) {
      circle.member = this.pairing.addMember({
        discoveryKey: circle.base.discoveryKey,
        onadd: (candidate) => this.admit(circle, candidate),
      });
    } else if (me?.role !== 'admin' && circle.member) {
      const member = circle.member;
      circle.member = null;
      await member.close();
    }
    this.refreshPeers();
    this.changed();
  }

  /**
   * A Circle this user is leaving reports nothing to main. It closes once an admin's device tells
   * it the removal arrived, or once the view that leaves this user out is confirmed.
   */
  private async refreshLeaving(circle: OpenCircle): Promise<void> {
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    this.diagCircleState(circle, me?.role ?? null);
    if (!me && circle.view.core.signedLength >= circle.view.core.length) {
      this.closeRemovedCircle(circle);
      return;
    }
    if (circle.member && me?.role !== 'admin') {
      const member = circle.member;
      circle.member = null;
      await member.close();
    }
    this.refreshPeers();
    this.changed();
  }

  /**
   * As an admin, report members who left since the last update. Only a device that was already
   * an admin with its current writer reports, so one catching up on history stays quiet.
   */
  private reportDepartures(circle: OpenCircle, before: CircleMemberRecord[]): void {
    const self = before.find((member) => member.identity === this.identityHex);
    if (self?.role !== 'admin' || self.writer !== this.writerHex(circle)) return;
    const now = new Set(circle.state.members.map((member) => member.identity));
    for (const member of before) {
      if (member.identity === this.identityHex || now.has(member.identity)) continue;
      if (!circle.departures.get(member.identity)) continue;
      this.diag('member.left', { circle: short(circle.secrets.key) });
      this.options.onMemberLeft?.({ key: circle.secrets.key!, circle: circle.state.name, name: member.name });
    }
  }

  /** The records in a Circle's view now, with whether each is confirmed. */
  private async readRecords(circle: OpenCircle): Promise<Map<string, CircleRecordEntry>> {
    const records = new Map<string, CircleRecordEntry>();
    const range = { gte: RECORDS_PREFIX, lt: `${RECORDS_PREFIX}\xff` };
    for await (const { key, seq, value } of circle.view.createReadStream(range)) {
      records.set(key, {
        ...(value as CircleRecord),
        circleKey: circle.secrets.key!,
        confirmed: seq < circle.view.core.signedLength,
      });
    }
    return records;
  }

  /**
   * Report what differs from the last scan. Comparing whole states, not following appends, also
   * covers Autobase undoing and reordering unconfirmed entries.
   */
  private async scanRecords(circle: OpenCircle): Promise<void> {
    let records: Map<string, CircleRecordEntry>;
    try {
      records = await this.readRecords(circle);
    } catch (err) {
      // The view closes under a scan when the Circle does.
      if (!circle.closing && !this.closed) this.log('record scan failed', { error: err instanceof Error ? err.name : typeof err });
      return;
    }
    const previous = circle.records;
    circle.records = records;
    const reactions = indexReactions(records.values());
    circle.changedReactions.push(...changedReactionRefs(circle.reactions, reactions));
    circle.reactions = reactions;
    for (const [key, record] of records) {
      const before = previous.get(key);
      if (before && JSON.stringify(before) === JSON.stringify(record)) continue;
      this.reportRecord({ ...record, deleted: false });
    }
    for (const [key, record] of previous) {
      if (!records.has(key)) this.reportRecord({ ...record, value: null, deleted: true });
    }
  }

  /** Report chat changes since the last scan. Runs after the record scan, which holds the channels. */
  private async scanChat(circle: OpenCircle): Promise<void> {
    if (circle.state.format < CHAT_FORMAT) return;
    let updates: CircleChatUpdate[];
    const refs = circle.changedReactions;
    circle.changedReactions = [];
    try {
      updates = await circle.chat.scan(circle.view, new Set(this.channels(circle).keys()), this.chatReader(circle), refs);
    } catch (err) {
      if (!circle.closing && !this.closed) {
        // The refs were not applied; the next scan takes them again.
        circle.changedReactions.unshift(...refs);
        this.log('chat scan failed', { error: err instanceof Error ? err.name : typeof err });
      }
      return;
    }
    for (const update of updates) this.options.onChat?.(update);
  }

  private channels(circle: OpenCircle): Map<string, string> {
    return chatChannels(circle.records.values());
  }

  private chatReader(circle: OpenCircle): ChatReader {
    return {
      circleKey: circle.secrets.key!,
      me: this.identityHex,
      signedLength: circle.view.core.signedLength,
      reactions: circle.reactions,
      members: new Set(circle.state.members.map((member) => member.identity)),
    };
  }

  private reportRecord(change: CircleRecordChange): void {
    if (this.recordApps.has(change.app)) this.options.onRecord?.(change);
  }

  /** Log a Circle's shape when it changes: membership, offers, invites and confirmation. */
  private diagCircleState(circle: OpenCircle, myRole: CircleRole | null): void {
    const summary = {
      circle: short(circle.secrets.key),
      myRole,
      members: circle.state.members.map((member) => `${short(member.identity)}:${member.role}`),
      offers: circle.state.offers.map(
        (offer) => `${short(offer.identity)}:${offer.models.length}m:${offer.available ? 'on' : 'paused'}${offer.away ? ':away' : ''}`
      ),
      invites: circle.state.invites.length,
      writable: circle.base.writable,
      isIndexer: circle.base.isIndexer,
      indexers: circle.base.system?.indexers.length ?? 0,
    };
    const key = JSON.stringify(summary);
    if (key === circle.lastDiag) return;
    circle.lastDiag = key;
    this.diag('circle.state', {
      ...summary,
      viewLength: circle.view.core.length,
      signedLength: circle.view.core.signedLength,
    });
  }

  private get supportedFormat(): number {
    return this.options.supportedFormat ?? CIRCLE_FORMAT;
  }

  private get identityHex(): string {
    return this.identity.publicKey.toString('hex');
  }

  private writerHex(circle: OpenCircle): string {
    return circle.base.local!.key.toString('hex');
  }

  /** This device's intro for a Circle whose writer core is `writer`. */
  private intro(writer: Buffer): CircleMemberIntro {
    const signature = crypto.sign(
      deviceProofMessage(this.device.publicKey.toString('hex'), writer.toString('hex')),
      this.identity.secretKey
    );
    return {
      identity: this.identityHex,
      name: this.name,
      writer: writer.toString('hex'),
      device: this.device.publicKey.toString('hex'),
      signature: signature.toString('hex'),
    };
  }

  private requireWritable(circle: OpenCircle): void {
    if (!circle.base.writable) throw new Error('This device is still joining this Circle.');
  }

  private async append(circle: OpenCircle, op: CircleOp): Promise<void> {
    if (circle.needsUpdate) throw new Error('This Circle needs a newer version of the app.');
    this.requireWritable(circle);
    await circle.base.append(op);
    await circle.base.update();
    await this.refreshCircle(circle);
  }

  private circle(key: string): OpenCircle {
    const circle = this.liveCircle(key);
    if (!circle) throw new Error('Not a member of that Circle.');
    return circle;
  }

  /** An open Circle this user hasn't left. */
  private liveCircle(key: string): OpenCircle | undefined {
    const circle = this.circles.get(key);
    return circle?.leaving ? undefined : circle;
  }

  async createCircle(name: string): Promise<CircleSecrets> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A Circle needs a name.');
    const circle = await this.bootCircle({ namespace: crypto.randomBytes(16).toString('hex'), name: trimmed });
    this.circles.set(circle.secrets.key!, circle);
    await this.append(circle, {
      type: 'create',
      name: trimmed,
      format: this.supportedFormat,
      member: this.intro(circle.base.local!.key),
    });
    this.diag('circle.created', { circle: short(circle.secrets.key) });
    await this.joinTopic(circle);
    return { ...circle.secrets, name: trimmed };
  }

  /** A new invite code, good for one person until `expiresAt` or until it is revoked. */
  async createInvite(key: string, expiresAt: number): Promise<{ id: string; code: string; expires: number }> {
    const circle = this.circle(key);
    const { id, invite, publicKey, expires } = BlindPairing.createInvite(circle.base.key, { expires: expiresAt });
    const record = { id: id.toString('hex'), publicKey: publicKey.toString('hex'), expires };
    await this.append(circle, { type: 'invite', invite: record });
    this.diag('invite.created', { circle: short(key), invite: short(record.id), expiresInH: Math.round((expires - Date.now()) / 3_600_000) });
    return { id: record.id, code: z32.encode(invite), expires };
  }

  /** `apply` skips what this device may not write without saying so, so check first. */
  private recordCircle(key: string, app: string, scope: CircleRecordScope, record: string): OpenCircle {
    if (!isRecordName(app) || !isRecordName(record) || !isRecordScope(scope)) throw new Error('That isn’t a record name.');
    const circle = this.circle(key);
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    if (!me) throw new Error('Not a member of that Circle.');
    if (scope === 'circle' && me.role !== 'admin') throw new Error('Only admins can change this Circle’s records.');
    return circle;
  }

  /** `keep` makes a `member` record stay after this user leaves, until an admin deletes it. */
  async setRecord(
    key: string,
    app: string,
    scope: CircleRecordScope,
    record: string,
    value: unknown,
    { keep = false }: { keep?: boolean } = {}
  ): Promise<void> {
    const circle = this.recordCircle(key, app, scope, record);
    if (!isRecordValue(value)) throw new Error('That record is too long, or isn’t JSON.');
    if (keep && scope !== 'member') throw new Error('Only a member’s own records can be kept.');
    if (keep && circle.state.format < CHAT_FORMAT) throw new Error('This Circle can’t keep records after their member leaves.');
    await this.append(circle, { type: 'record-set', app, scope, key: record, value, ...(keep ? { keep: true as const } : {}) });
  }

  /** With `identity`, an admin deletes a kept record of someone who is no longer a member. */
  async deleteRecord(key: string, app: string, scope: CircleRecordScope, record: string, identity?: string): Promise<void> {
    const circle = this.recordCircle(key, app, scope, record);
    if (identity === undefined || identity === this.identityHex) {
      await this.append(circle, { type: 'record-del', app, scope, key: record });
      return;
    }
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    if (me?.role !== 'admin') throw new Error('Only admins can delete another member’s record.');
    if (scope !== 'member' || circle.state.format < CHAT_FORMAT) throw new Error('That record can’t be deleted for someone else.');
    if (circle.state.members.some((member) => member.identity === identity)) throw new Error('That person is still in this Circle.');
    await this.append(circle, { type: 'record-del', app, scope, key: record, identity });
  }

  /** One app's records in a Circle: its `circle` records and every member's. */
  async listRecords(key: string, app: string): Promise<CircleRecordEntry[]> {
    const records = await this.readRecords(this.circle(key));
    return [...records.values()].filter((record) => record.app === app);
  }

  // ---- Chat (ADR 0042) -------------------------------------------------------------------------

  /** A Circle with chat, and a channel it has. */
  private chatCircle(key: string, channel: string): OpenCircle {
    const circle = this.circle(key);
    if (circle.state.format < CHAT_FORMAT) throw new Error('This Circle doesn’t have chat.');
    if (!this.channels(circle).has(channel)) throw new Error('That channel isn’t in this Circle.');
    return circle;
  }

  /** Channels with unread counts after this device's read positions. */
  async listChannels(key: string, reads: Record<string, CircleReadPosition>, channelMentions: boolean): Promise<CircleChannel[]> {
    const circle = this.circle(key);
    if (circle.state.format < CHAT_FORMAT) return [];
    const channels: CircleChannel[] = [];
    for (const [id, name] of this.channels(circle)) {
      const counts = await channelUnread(circle.view, id, reads[id], {
        format: circle.state.format,
        me: this.identityHex,
        channelMentions,
        reactions: circle.reactions,
        now: Date.now(),
      });
      channels.push({ id, name, ...counts });
    }
    return channels;
  }

  async listMessages(
    key: string,
    channel: string,
    options: { before?: CircleMessageRef; limit: number }
  ): Promise<{ messages: CircleMessage[]; more: boolean }> {
    const circle = this.chatCircle(key, channel);
    return readChatMessages(circle.view, channel, options, this.chatReader(circle));
  }

  /** One message of a channel by reference, or null when this view doesn't hold it. */
  async getMessage(key: string, channel: string, ref: CircleMessageRef): Promise<CircleMessage | null> {
    const circle = this.chatCircle(key, channel);
    return isMessageId(ref.id) ? findChatMessage(circle.view, channel, ref, this.chatReader(circle)) : null;
  }

  /** Post as this user; returns the message's id. */
  async postMessage(
    key: string,
    channel: string,
    text: string,
    { shared, mentions, reply }: { shared?: CircleMessageShared; mentions?: CircleMessageMentions; reply?: CircleMessageRef } = {}
  ): Promise<string> {
    const circle = this.chatCircle(key, channel);
    if (mentions && circle.state.format < MENTIONS_FORMAT) throw new Error(MENTIONS_NEED_UPDATE);
    if (reply && circle.state.format < REPLIES_FORMAT) throw new Error(REPLIES_NEED_UPDATE);
    const op = {
      type: 'chat-post' as const,
      channel,
      id: crypto.randomBytes(16).toString('hex'),
      text,
      at: Date.now(),
      ...(shared ? { shared } : {}),
      ...(mentions ? { mentions } : {}),
      ...(reply ? { reply } : {}),
    };
    const problem = chatPostProblem(op, circle.state.format);
    if (problem === 'bad message text') throw new Error('A message needs text, up to 12 KB.');
    if (problem === 'chat operation too long') throw new Error('That message is too long.');
    if (problem) throw new Error('That message can’t be posted.');
    await this.append(circle, op);
    return op.id;
  }

  /** Only the author edits. */
  async editMessage(key: string, channel: string, id: string, text: string, mentions?: CircleMessageMentions): Promise<void> {
    const circle = this.chatCircle(key, channel);
    if (mentions && circle.state.format < MENTIONS_FORMAT) throw new Error(MENTIONS_NEED_UPDATE);
    if (mentions && !cleanMentions(mentions, () => true)) throw new Error('That message can’t be posted.');
    const mine = { author: this.identityHex, id };
    const message = isMessageId(id) ? await findChatMessage(circle.view, channel, mine, this.chatReader(circle)) : null;
    if (!message) throw new Error('That message isn’t yours, or isn’t here.');
    if (message.deleted) throw new Error('That message was deleted.');
    if (!isMessageText(text, Boolean(message.call))) throw new Error('A message needs text, up to 12 KB.');
    await this.append(circle, { type: 'chat-edit', channel, id, text, ...(mentions ? { mentions } : {}) });
  }

  /** The author or an admin deletes. */
  async deleteMessage(key: string, channel: string, author: string, id: string): Promise<void> {
    const circle = this.chatCircle(key, channel);
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    if (author !== this.identityHex && me?.role !== 'admin') throw new Error('Only its author or an admin can delete a message.');
    const ref = { author, id };
    const message = isMessageId(id) ? await findChatMessage(circle.view, channel, ref, this.chatReader(circle)) : null;
    if (!message) throw new Error('That message isn’t here.');
    if (message.deleted) return;
    await this.append(circle, { type: 'chat-delete', channel, author, id });
  }

  /**
   * Add or take back this user's reaction. The user's reactions to one message are one `reactions`
   * record, so this reads the record as it is now, changes one emoji and writes it back whole.
   */
  async reactMessage(key: string, channel: string, ref: CircleMessageRef, emoji: string, on: boolean): Promise<void> {
    // The network process runs requests concurrently, and `circle.records` only changes in the scan
    // inside a write. One call at a time per Circle makes each read the previous call's result.
    const previous = this.reactQueues.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.toggleReaction(key, channel, ref, emoji, on));
    const tail: Promise<void> = run.catch((): void => undefined);
    this.reactQueues.set(key, tail);
    void tail.then(() => {
      if (this.reactQueues.get(key) === tail) this.reactQueues.delete(key);
    });
    return run;
  }

  private async toggleReaction(key: string, channel: string, ref: CircleMessageRef, emoji: string, on: boolean): Promise<void> {
    const circle = this.chatCircle(key, channel);
    if (!isReactionEmoji(emoji)) throw new Error('That isn’t an emoji.');
    const message = isMessageId(ref.id) ? await findChatMessage(circle.view, channel, ref, this.chatReader(circle)) : null;
    if (!message) throw new Error('That message isn’t in this channel.');
    if (message.deleted) throw new Error('That message was deleted.');
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    if (!me) throw new Error('Not a member of that Circle.');
    const record = reactionRecordKey(channel, ref.author, ref.id);
    const existing = circle.records.get(memberRecordKey(this.identityHex, REACTIONS_APP, record));
    const current = (existing ? parseReactionRecord(existing)?.emoji : undefined) ?? [];
    const has = current.some((x) => x.e === emoji);
    if (on === has) return;
    if (!on) {
      const rest = current.filter((x) => x.e !== emoji);
      if (rest.length) await this.setReactions(key, channel, ref, record, me.name, rest);
      else await this.deleteRecord(key, REACTIONS_APP, 'member', record);
      return;
    }
    if (current.length >= MAX_REACTIONS_PER_MESSAGE) {
      throw new Error(`You’ve used ${MAX_REACTIONS_PER_MESSAGE} reactions on this message`);
    }
    await this.setReactions(key, channel, ref, record, me.name, [...current, { e: emoji, at: Date.now() }]);
  }

  private setReactions(
    key: string,
    channel: string,
    ref: CircleMessageRef,
    record: string,
    name: string,
    emoji: { e: string; at: number }[]
  ): Promise<void> {
    const value: ReactionRecordValue = { channel, author: ref.author, id: ref.id, name, emoji };
    return this.setRecord(key, REACTIONS_APP, 'member', record, value, { keep: true });
  }

  /** Move a Circle to a later format. Builds that can't apply it stop until they update (ADR 0038). */
  async setFormat(key: string, format: number): Promise<void> {
    await this.append(this.circle(key), { type: 'set-format', format });
  }

  async revokeInvite(key: string, id: string): Promise<void> {
    await this.append(this.circle(key), { type: 'revoke-invite', id });
  }

  async setRole(key: string, identity: string, role: CircleRole): Promise<void> {
    const circle = this.circle(key);
    if (role === 'member') await this.revokeInvitesFrom(circle, identity);
    await this.append(circle, { type: 'set-role', identity, role });
  }

  async removeMember(key: string, identity: string): Promise<void> {
    const circle = this.circle(key);
    await this.revokeInvitesFrom(circle, identity);
    await this.append(circle, { type: 'remove-member', identity });
  }

  /**
   * An invite stops working when its creator stops being an admin. Uses the `revoke-invite`
   * operation, so `apply` is unchanged, and goes first because a demoted author can't revoke.
   */
  private async revokeInvitesFrom(circle: OpenCircle, identity: string): Promise<void> {
    const { members, invites } = circle.state;
    const lastAdmin = !members.some((member) => member.role === 'admin' && member.identity !== identity);
    if (lastAdmin) return;
    const now = Date.now();
    for (const invite of invites) {
      if (invite.createdBy !== identity || invite.revoked || invite.usedBy) continue;
      if (invite.expires && invite.expires < now) continue;
      await this.append(circle, { type: 'revoke-invite', id: invite.id });
    }
  }

  /**
   * Leave a Circle: write this member's removal and stop showing the Circle. It stays open here
   * until an admin confirms the removal, which can be after restarts, then closes and `onRemoved`
   * fires. Main keeps its secrets, marked as leaving, until then.
   */
  async leaveCircle(key: string): Promise<void> {
    const circle = this.circle(key);
    this.requireWritable(circle);
    const { members } = circle.state;
    const me = members.find((member) => member.identity === this.identityHex);
    const otherAdmin = members.some((member) => member.role === 'admin' && member.identity !== this.identityHex);
    if (me?.role === 'admin' && !otherAdmin) throw new Error(LAST_ADMIN);
    await this.revokeInvitesFrom(circle, this.identityHex);
    circle.leaving = true;
    try {
      await this.append(circle, { type: 'remove-member', identity: this.identityHex });
    } catch (err) {
      circle.leaving = false;
      throw err;
    }
    if (circle.state.members.some((member) => member.identity === this.identityHex)) {
      circle.leaving = false;
      await this.refreshCircle(circle);
      throw new Error(LAST_ADMIN);
    }
    this.diag('circle.leaving', { circle: short(key) });
  }

  /**
   * Delete a Circle whose only member is this user: close it, then purge its cores here. Nothing
   * goes in the log, because no other peer is a member. Main forgets its secrets.
   */
  async deleteCircle(key: string): Promise<void> {
    const circle = this.circle(key);
    const { members } = circle.state;
    if (members.length !== 1 || members[0].identity !== this.identityHex) {
      throw new Error('Only a Circle’s last member can delete it.');
    }
    circle.closing = true;
    let cores: Buffer[];
    try {
      cores = await this.circleCores(circle);
    } catch (err) {
      circle.closing = false;
      throw err;
    }
    await this.closeCircle(circle);
    this.dropRemovedDevices(key);
    // A failed purge only leaves encrypted blocks on disk, and main still forgets the key.
    const purged = await this.store.purge(cores, { force: true }).catch((err: unknown): null => {
      this.log('purging a deleted Circle failed', { error: String(err) });
      return null;
    });
    this.diag('circle.deleted', { circle: short(key), cores: cores.length, purged: purged?.length ?? 0 });
  }

  /**
   * The cores Autobase can name: first core, writers past and present, and current views. Views
   * from an earlier indexer set aren't listed anywhere, so those stay on disk, still encrypted.
   */
  private async circleCores(circle: OpenCircle): Promise<Buffer[]> {
    const { base } = circle;
    const keys = [base.key, base.core.key];
    if (base.local) keys.push(base.local.key);
    if (base.system) for await (const writer of base.system.list()) keys.push(writer.key);
    for (const view of base._viewStore.getViews()) if (view.core) keys.push(view.core.key);
    return [...new Map(keys.map((coreKey) => [coreKey.toString('hex'), coreKey])).values()];
  }

  private async closeCircle(circle: OpenCircle): Promise<void> {
    this.circles.delete(circle.secrets.key!);
    if (circle.member) await circle.member.close();
    await this.swarm.leave(circle.base.discoveryKey);
    await circle.base.close();
    this.refreshPeers();
    this.changed();
  }

  /** An online admin's side of an invite (ADR 0032 §5). */
  private async admit(circle: OpenCircle, candidate: BlindCandidateRequest): Promise<void> {
    const id = candidate.inviteId.toString('hex');
    const invite = (await circle.view.get(inviteKey(id)))?.value as CircleInviteRecord | undefined;
    const outcome = (result: string) => this.diag('invite.admit', { circle: short(circle.secrets.key), invite: short(id), result });
    if (!invite) return outcome('unknown-invite');
    // A reply, even a refusal, is sealed to the request's session, which `open` reads.
    candidate.open(Buffer.from(invite.publicKey, 'hex'));
    let intro: unknown;
    try {
      intro = JSON.parse(candidate.userData!.toString('utf8'));
    } catch {
      outcome('bad-intro-json');
      return candidate.deny({ status: STATUS_REJECTED });
    }
    if (!introIsValid(intro, { verify: crypto.verify })) {
      outcome('bad-intro');
      return candidate.deny({ status: STATUS_REJECTED });
    }
    const { format } = intro as { format?: unknown };
    if (!Number.isInteger(format) || (format as number) < circle.state.format) {
      // Without this, a build that can't apply this Circle's operations would skip them and diverge.
      outcome('old-build');
      return candidate.deny({ status: STATUS_REJECTED });
    }
    const admitted = () => circle.state.members.some((member) => member.writer === (intro as CircleMemberIntro).writer);
    // The invitee asks again until it hears back; one already added just hears back again.
    if (!(invite.usedBy === intro.identity && admitted())) {
      if (invite.revoked) {
        outcome('revoked');
        return candidate.deny({ status: STATUS_REJECTED });
      }
      if (invite.usedBy) {
        outcome('used');
        return candidate.deny({ status: STATUS_USED });
      }
      if (invite.expires && invite.expires < Date.now()) {
        outcome('expired');
        return candidate.deny({ status: STATUS_EXPIRED });
      }
      await this.append(circle, { type: 'add-member', member: intro, invite: id });
      if (!admitted()) {
        outcome('add-skipped');
        return candidate.deny({ status: STATUS_REJECTED });
      }
      outcome('added');
    } else {
      outcome('re-confirmed');
    }
    candidate.confirm({ key: circle.base.key, encryptionKey: circle.base.encryptionKey! });
    this.log('admitted a member', { circle: circle.secrets.key!.slice(0, 12) });
  }

  /** Stop waiting for an admin. Nothing is kept: a device isn't in a Circle until it's admitted. */
  cancelJoin(): void {
    this.stopJoin?.();
  }

  /**
   * Join with an invite code. `onPaired` fires once an admin has admitted this device, after
   * which cancelling does nothing. Resolves once the Circle is writable here or the wait runs
   * out, with the secrets main must keep. Rejects when the invite is refused or the join is
   * cancelled.
   */
  async joinCircle(code: string): Promise<CircleSecrets> {
    let invite: Buffer;
    try {
      invite = z32.decode(code.trim());
    } catch {
      throw new Error('That isn’t a Circle invite.');
    }
    const started = Date.now();
    let candidate: BlindCandidate | null = null;
    let stopped = false;
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.stopJoin = () => {
        stopped = true;
        void candidate?.close();
        this.diag('join.cancelled', { ms: Date.now() - started });
        reject(new Error('Join cancelled.'));
      };
    });
    cancelled.catch((): undefined => undefined);

    const namespace = crypto.randomBytes(16).toString('hex');
    const local = Autobase.getLocalCore(this.store.namespace(namespace));
    await local.ready();
    const writer = local.key;
    await local.close();
    if (stopped) throw new Error('Join cancelled.');

    this.diag('join.request', {});
    const asking: BlindCandidate = this.pairing.addCandidate({
      invite,
      userData: Buffer.from(JSON.stringify({ ...this.intro(writer), format: this.supportedFormat })),
      onadd: async () => undefined,
    });
    candidate = asking;
    const refused = new Promise<never>((_resolve, reject) => {
      asking.request.once('rejected', (err: Error) => {
        void asking.close();
        this.diag('join.refused', { code: (err as Error & { code?: string }).code ?? null, ms: Date.now() - started });
        reject(new Error(refusalMessage(err)));
      });
    });
    const paired = await Promise.race([asking.pairing, refused, cancelled]).finally(() => {
      this.stopJoin = null;
    });
    if (!paired) throw new Error('The invite was not answered.');
    const secrets: CircleSecrets = {
      namespace,
      key: paired.key.toString('hex'),
      encryptionKey: paired.encryptionKey.toString('hex'),
    };
    this.diag('join.paired', { circle: short(secrets.key), ms: Date.now() - started });
    this.options.onPaired?.(secrets);
    // Joining again before an admin confirmed the leave: the new membership replaces it.
    const left = this.circles.get(secrets.key!);
    if (left?.leaving) await this.closeCircle(left);
    await this.releaseLocalWriter(paired.key);
    await this.openCircle(secrets);
    const circle = this.circle(secrets.key!);
    const writable = await this.untilWritable(circle);
    this.diag(writable ? 'join.writable' : 'join.not-writable', {
      circle: short(secrets.key),
      ms: Date.now() - started,
      members: circle.state.members.length,
    });
    return { ...secrets, name: circle.state.name };
  }

  /**
   * Autobase keeps the writer it last used under the Circle's first core, whichever namespace
   * opened it. After leaving, that writer is removed, so a join would open it and never write.
   */
  private async releaseLocalWriter(key: Buffer): Promise<void> {
    const bootstrap = this.store.get({ key, active: false });
    await bootstrap.ready();
    await bootstrap.setUserData('autobase/local', null);
    await bootstrap.close();
  }

  /** False when the wait ran out; the Circle stays open and can still become writable later. */
  private async untilWritable(circle: OpenCircle): Promise<boolean> {
    if (circle.base.writable) return true;
    let timer: NodeJS.Timeout | undefined;
    const writable = await new Promise<boolean>((resolve) => {
      circle.base.once('writable', () => resolve(true));
      timer = setTimeout(() => resolve(false), JOIN_WRITABLE_MS);
      timer.unref();
    });
    clearTimeout(timer);
    await this.refreshCircle(circle);
    return writable;
  }

  // ---- Shared models (ADR 0034) --------------------------------------------------------------

  /** Publish or replace this user's offer in a Circle. */
  async publishOffer(key: string, offer: CircleOffer): Promise<void> {
    await this.append(this.circle(key), { type: 'offer', offer });
    this.diag('offer.published', {
      circle: short(key),
      models: offer.models.map((model) => model.id),
      available: offer.available,
      away: offer.away,
    });
  }

  async withdrawOffer(key: string): Promise<void> {
    await this.append(this.circle(key), { type: 'withdraw-offer' });
    this.diag('offer.withdrawn', { circle: short(key) });
  }

  /** Where this user's gateway forwards to; null stops serving without touching offers. */
  setShareUpstream(upstream: GatewayUpstream | null, limits?: CircleLimits): void {
    this.shareUpstream = upstream;
    this.gateway.setLimits(limits ?? null);
    let host: string | null = null;
    let port: string | null = null;
    try {
      if (upstream) ({ hostname: host, port } = new URL(upstream.baseUrl));
    } catch {
      host = 'unparseable';
    }
    this.diag('share.upstream', { set: Boolean(upstream), addr: host === 'localhost' ? 'loopback' : addressClass(host), port, apiKey: Boolean(upstream?.apiKey) });
  }

  /** What this user's service gateway serves; replaces what it served before. */
  setServiceSharing(sharing: ServiceSharing): void {
    this.serviceUpstreams = new Map(Object.entries(sharing.upstreams));
    this.serviceGrants = new Map(
      sharing.grants.map((grant) => [
        grantKey(grant.circle, grant.service, grant.identity),
        { read: grant.read, ...(grant.write ? { write: grant.write } : {}) },
      ])
    );
    this.diag('service.sharing', { services: this.serviceUpstreams.size, grants: this.serviceGrants.size });
  }

  /**
   * Call a service a member shares (ADR 0048 §3). Rejects when they aren't connected; the
   * consumer's listener says the provider is offline (§11).
   */
  requestService(
    key: string,
    provider: string,
    request: Omit<ServiceRequest, 'id' | 'circle'>,
    signal?: AbortSignal
  ): Promise<SharedModelResponse> {
    return this.requestLink(this.serviceLink, key, provider, request, signal);
  }

  /**
   * Ask a member's gateway for one of their shared models. Rejects when they aren't connected;
   * the router treats that as unreachable (ADR 0033 §6).
   */
  requestSharedModel(key: string, provider: string, request: SharedModelCall, signal?: AbortSignal): Promise<SharedModelResponse> {
    return this.requestLink(this.inferenceLink, key, provider, request, signal);
  }

  /** Send `request` over the `kind` link to `provider`'s device in Circle `key`. */
  private requestLink<R extends { id: number; circle: string }>(
    kind: LinkKind<R>,
    key: string,
    provider: string,
    request: Omit<R, 'id' | 'circle'>,
    signal?: AbortSignal
  ): Promise<SharedModelResponse> {
    const member = this.circle(key).state.members.find((candidate) => candidate.identity === provider);
    const peer = member ? this.peers.get(member.device) : undefined;
    const link = peer ? kind.get(peer) : null;
    if (!link) {
      this.diag(`${kind.spec.events.call}.no-link`, {
        circle: short(key),
        provider: short(provider),
        member: Boolean(member),
        connected: Boolean(peer),
        replicating: peer?.replicating ?? false,
      });
      return Promise.reject(new Error('The provider is not connected.'));
    }
    return link.request({ ...request, circle: key } as Omit<R, 'id'>, signal);
  }

  /**
   * How much of a Circle's view is ordered for good. View blocks at or past `signedLength` are
   * unconfirmed: a majority of the indexers (the admins' devices) haven't acked them yet, so
   * they can still be reordered (docs/circles-autobase-confirmation.md). `indexers` counts the
   * admins' devices in the view; `indexer` says whether this device is an active indexer yet,
   * which a newly promoted admin's device becomes only after it acks while online.
   */
  confirmation(key: string): { indexers: number; indexer: boolean; length: number; signedLength: number } {
    const circle = this.circle(key);
    return {
      indexers: circle.base.system?.indexers.length ?? 0,
      indexer: circle.base.isIndexer,
      length: circle.view.core.length,
      signedLength: circle.view.core.signedLength,
    };
  }

  setName(name: string): void {
    this.name = name.trim() || this.name;
  }

  snapshot(): CirclesSnapshot {
    const online = new Set(this.peers.keys());
    const me = this.identityHex;
    const open = [...this.circles.values()];
    const circles: CircleSnapshot[] = open.filter((circle) => !circle.leaving).map((circle) => {
      const mine = circle.state.members.find((member) => member.identity === me);
      return {
        key: circle.secrets.key!,
        name: circle.state.name,
        myRole: mine?.role ?? null,
        needsUpdate: circle.needsUpdate,
        format: circle.state.format,
        writable: circle.base.writable,
        members: circle.state.members.map((member) => ({
          identity: member.identity,
          name: member.name,
          role: member.role,
          isMe: member.identity === me,
          online: member.identity === me || online.has(member.device),
        })),
        invites: circle.state.invites.map((invite) => ({
          id: invite.id,
          expires: invite.expires,
          revoked: Boolean(invite.revoked),
          used: Boolean(invite.usedBy),
        })),
        offers: circle.state.offers.flatMap((offer) => {
          const provider = circle.state.members.find((member) => member.identity === offer.identity);
          if (!provider) return [];
          return [
            {
              identity: offer.identity,
              name: provider.name,
              isMine: offer.identity === me,
              models: offer.models,
              available: offer.available,
              away: offer.away,
              online: offer.identity === me || online.has(provider.device),
            },
          ];
        }),
      };
    });
    const leaving = open.filter((circle) => circle.leaving).map((circle) => ({ key: circle.secrets.key!, name: circle.state.name }));
    return { identity: me, circles, ...(leaving.length ? { leaving } : {}) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gateway.close();
    this.serviceGateway.close();
    this.tunnels.closeAll();
    if (this.tunnelSampler) clearInterval(this.tunnelSampler);
    await this.pairing.close();
    await this.swarm.destroy();
    for (const circle of this.circles.values()) await circle.base.close();
    await this.folders.close();
    await this.store.close();
  }
}

type BlindCandidateRequest = Parameters<NonNullable<Parameters<BlindPairing['addMember']>[0]['onadd']>>[0];

function refusalMessage(err: Error): string {
  const code = (err as Error & { code?: string }).code ?? '';
  if (code.includes('EXPIRED')) return 'That invite has expired. Ask for a new one.';
  if (code.includes('USED')) return 'That invite has already been used. Ask for a new one.';
  return 'That invite was refused. It may have been revoked.';
}
