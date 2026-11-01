/**
 * The Circles runtime inside the network utilityProcess (ADR 0032). It holds one Corestore and one
 * Hyperswarm, and opens an Autobase for each Circle in its own Corestore namespace. Main hands it
 * the user's seeds and each Circle's secrets, and keeps them; this side keeps nothing but blocks.
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
  applyCircleNodes,
  CIRCLE_FORMAT,
  CIRCLE_KEY,
  deviceProofMessage,
  INVITES_PREFIX,
  introIsValid,
  inviteKey,
  isRecordName,
  isRecordScope,
  isRecordValue,
  lostMembership,
  MEMBERS_PREFIX,
  OFFERS_PREFIX,
  RECORDS_PREFIX,
  type CircleHeader,
  type CircleInviteRecord,
  type CircleMemberIntro,
  type CircleMemberRecord,
  type CircleOffer,
  type CircleOfferRecord,
  type CircleOp,
  type CircleRecord,
  type CircleRecordScope,
  type CircleRole,
  type CircleView,
} from './circleOps';
import { addressClass } from './addressClass';
import { decodeSignal, encodeSignal, SignalStats, type CircleSignal } from './circleSignals';
import type { CircleDayUsage, CircleLimits, CircleServing } from '../../../shared/types/circles';
import { InferenceLink, onInferenceOpen, type SharedModelResponse } from './inferenceChannel';
import { InferenceGateway, type GatewayUpstream } from './inferenceGateway';
import type {
  CircleRecordChange,
  CircleRecordEntry,
  CircleSecrets,
  CircleSnapshot,
  CirclesSnapshot,
  SharedModelCall,
} from './networkMessages';
import { RemovalLink } from './removalNotice';
import { onSignalOpen, SignalLink } from './signalChannel';

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
  /** Called whenever what `snapshot()` returns may have changed. */
  onChange?: () => void;
  /** A peer signal on a topic passed to `setSignalTopics`, from a current member of its Circle. */
  onSignal?: (signal: CircleSignal) => void;
  /** A record of an app passed to `setRecordApps` changed. */
  onRecord?: (change: CircleRecordChange) => void;
  /** An admin admitted this device. Main keeps the secrets now: the Circle opens from here on. */
  onPaired?: (secrets: CircleSecrets) => void;
  /** This device was removed from a Circle and has closed it. Main forgets its secrets. */
  onRemoved?: (key: string) => void;
  log?: (message: string, data?: Record<string, unknown>) => void;
  /**
   * Diagnostics events for a test run (metadata only: key prefixes, counts, timings, address
   * classes; never names, codes, keys, prompts or replies).
   */
  diag?: (event: string, data: Record<string, unknown>) => void;
}

const short = (key: string | null | undefined): string | null => (key ? key.slice(0, 8) : null);

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
  /** The scan in progress; scans run one at a time. */
  scan: Promise<void>;
  /** The last state written to diagnostics, to log changes only. */
  lastDiag: string;
  /** Leaving or being removed: this device's own removal closes the Circle only once. */
  closing: boolean;
}

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

function asView(bee: Hyperbee): CircleView {
  return {
    get: (key) => bee.get(key),
    put: async (key, value) => {
      await bee.put(key, value);
    },
    del: async (key) => {
      await bee.del(key);
    },
    list: (prefix) => listPrefix(bee, prefix),
  };
}

export class CircleNetwork {
  readonly identity: { publicKey: Buffer; secretKey: Buffer };
  readonly device: { publicKey: Buffer; secretKey: Buffer };
  private readonly store: Corestore;
  private readonly swarm: Hyperswarm;
  private readonly pairing: BlindPairing;
  private readonly circles = new Map<string, OpenCircle>();
  /**
   * Connected devices, by device key: whether this side is replicating with each, and the
   * inference and signal channels, which open alongside replication.
   */
  private readonly peers = new Map<
    string,
    {
      connection: SecretStream;
      replicating: boolean;
      link: InferenceLink | null;
      signals: SignalLink | null;
      removal: RemovalLink | null;
      /** Circles this connection has been told it was removed from. */
      noticed: Set<string>;
      dropTimer: NodeJS.Timeout | null;
      connectedAt: number;
    }
  >();
  /** Devices removed from each Circle, by Circle key, kept so one offline then hears on return. */
  private readonly removedDevices: Map<string, Set<string>>;
  private readonly gateway: InferenceGateway;
  /** This user's model server, when they share; main sets it. */
  private shareUpstream: GatewayUpstream | null = null;
  private stopJoin: (() => void) | null = null;
  /** The signal topics main listens to; others are dropped here and never cross to main. */
  private signalTopics = new Set<string>();
  private recordApps = new Set<string>();
  private readonly signalStats = new SignalStats();
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
      offerFor: (key) => this.circles.get(key)?.state.offers.find((offer) => offer.identity === this.identityHex) ?? null,
      memberFor: (key, device) =>
        this.circles.get(key)?.state.members.find((member) => member.device === device)?.identity ?? null,
      upstream: () => this.shareUpstream,
      log: (message, data) => this.log(message, data),
      usage: options.usage,
      onUsage: options.onUsage,
    });
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
        link: peer.link ? (peer.link.closed ? 'closed' : 'open') : null,
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
      })),
      gateway: this.gateway.stats(),
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
      link: null,
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
    onInferenceOpen(connection, () => this.attachInference(device, 'remote'));
    onSignalOpen(connection, () => this.attachSignals(device));
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
        this.attachInference(device, 'local');
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
      peer.removal.send(Buffer.from(key, 'hex'));
      this.diag('removal.notice-sent', { circle: short(key), device: short(device) });
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
    this.diag('circle.removed-here', { circle: short(key) });
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

  /** Open the inference channel with a known device, unless it is already open. */
  private attachInference(device: string, opener: 'local' | 'remote'): void {
    const peer = this.peers.get(device);
    if (!peer?.replicating) {
      // A remote open from a device not known here is turned down by Protomux.
      if (opener === 'remote') this.diag('link.refused-unknown', { device: short(device), connected: Boolean(peer) });
      return;
    }
    if (peer.link && !peer.link.closed) return;
    const link = InferenceLink.attach(
      peer.connection,
      device,
      this.gateway,
      () => {
        if (peer.link === link) peer.link = null;
      },
      (event, data) => this.diag(event, data)
    );
    if (link) this.diag('link.attach', { device: short(device), opener });
    peer.link = link;
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
    const sender = this.circles.get(frame.circle)?.state.members.find((member) => member.device === device);
    if (!sender) return this.signalStats.onDropped('not-member');
    if (!this.signalTopics.has(frame.topic)) return this.signalStats.onDropped('unknown-topic');
    this.signalStats.onReceived(frame.topic, raw.length);
    this.options.onSignal?.({ ...frame, from: sender.identity });
  }

  /** The topics to deliver through `onSignal`; replaces the previous list. */
  /** The apps `onRecord` reports. Records of other apps still replicate and stay in the view. */
  setRecordApps(apps: string[]): void {
    this.recordApps = new Set(apps);
  }

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
    const base = new Autobase(namespace, secrets.key ? Buffer.from(secrets.key, 'hex') : null, {
      encrypt: true,
      encryptionKey: secrets.encryptionKey ? Buffer.from(secrets.encryptionKey, 'hex') : undefined,
      ackInterval: this.options.ackInterval ?? 10_000,
      open: (viewStore) =>
        new Hyperbee(viewStore.get({ name: 'view' }), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: (nodes, view, host) =>
        applyCircleNodes(nodes, asView(view), host, {
          verify: (message, signature, publicKey) => crypto.verify(message, signature, publicKey),
          supportedFormat: this.supportedFormat,
          onSkip: (reason) => this.log('circle op skipped', { reason }),
        }),
      valueEncoding: 'json',
    });
    await base.ready();
    const circle: OpenCircle = {
      secrets: {
        ...secrets,
        key: base.key.toString('hex'),
        encryptionKey: base.encryptionKey!.toString('hex'),
      },
      base,
      view: base.view,
      member: null,
      state: { name: '', format: this.supportedFormat, members: [], invites: [], offers: [] },
      needsUpdate: false,
      records: new Map(),
      scan: Promise.resolve(),
      lastDiag: '',
      closing: false,
    };
    base.on('update', () => void this.refreshCircle(circle));
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
    circle.scan = circle.scan.then(() => this.scanRecords(circle));
    await circle.scan;
    const me = circle.state.members.find((member) => member.identity === this.identityHex);
    this.diagCircleState(circle, me?.role ?? null);
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
    for (const [key, record] of records) {
      const before = previous.get(key);
      if (before && JSON.stringify(before) === JSON.stringify(record)) continue;
      this.reportRecord({ ...record, deleted: false });
    }
    for (const [key, record] of previous) {
      if (!records.has(key)) this.reportRecord({ ...record, value: null, deleted: true });
    }
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
    const circle = this.circles.get(key);
    if (!circle) throw new Error('Not a member of that Circle.');
    return circle;
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

  async setRecord(key: string, app: string, scope: CircleRecordScope, record: string, value: unknown): Promise<void> {
    const circle = this.recordCircle(key, app, scope, record);
    if (!isRecordValue(value)) throw new Error('That record is too long, or isn’t JSON.');
    await this.append(circle, { type: 'record-set', app, scope, key: record, value });
  }

  async deleteRecord(key: string, app: string, scope: CircleRecordScope, record: string): Promise<void> {
    await this.append(this.recordCircle(key, app, scope, record), { type: 'record-del', app, scope, key: record });
  }

  /** One app's records in a Circle: its `circle` records and every member's. */
  async listRecords(key: string, app: string): Promise<CircleRecordEntry[]> {
    const records = await this.readRecords(this.circle(key));
    return [...records.values()].filter((record) => record.app === app);
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

  /** Leave a Circle: remove this member, then close it here. Main forgets its secrets. */
  async leaveCircle(key: string): Promise<void> {
    const circle = this.circle(key);
    this.requireWritable(circle);
    circle.closing = true;
    await this.revokeInvitesFrom(circle, this.identityHex);
    await this.append(circle, { type: 'remove-member', identity: this.identityHex });
    if (circle.state.members.some((member) => member.identity === this.identityHex)) {
      circle.closing = false;
      throw new Error('The last admin can’t leave. Make someone else an admin first.');
    }
    await this.closeCircle(circle);
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

  /**
   * Ask a member's gateway for one of their shared models. Rejects when they aren't connected;
   * the router treats that as unreachable (ADR 0033 §6).
   */
  requestSharedModel(
    key: string,
    provider: string,
    request: SharedModelCall,
    signal?: AbortSignal
  ): Promise<SharedModelResponse> {
    const member = this.circle(key).state.members.find((candidate) => candidate.identity === provider);
    const peer = member ? this.peers.get(member.device) : undefined;
    const link = peer?.link ?? null;
    if (!link) {
      this.diag('shared.no-link', {
        circle: short(key),
        provider: short(provider),
        member: Boolean(member),
        connected: Boolean(peer),
        replicating: peer?.replicating ?? false,
      });
      return Promise.reject(new Error('The provider is not connected.'));
    }
    return link.request({ ...request, circle: key }, signal);
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
    const circles: CircleSnapshot[] = [...this.circles.values()].map((circle) => {
      const mine = circle.state.members.find((member) => member.identity === me);
      return {
        key: circle.secrets.key!,
        name: circle.state.name,
        myRole: mine?.role ?? null,
        needsUpdate: circle.needsUpdate,
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
    return { identity: me, circles };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.gateway.close();
    await this.pairing.close();
    await this.swarm.destroy();
    for (const circle of this.circles.values()) await circle.base.close();
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
