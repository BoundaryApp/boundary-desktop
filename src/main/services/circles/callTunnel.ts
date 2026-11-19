/**
 * Call tunnels (the call tunnel spike): UDP endpoints on `127.0.0.1` whose packets cross a peer's
 * Hyperswarm connection as unordered messages. The renderer gives its peer connection this
 * Mac's endpoint as a remote candidate, so WebRTC reaches the other Mac wherever the Circles
 * connection does. WebRTC's own DTLS-SRTP still encrypts the media inside.
 *
 * A message is an 8-byte header and one UDP payload: magic `BCT1`, a 3-byte tunnel id the caller
 * picks, and a part byte. The part byte's top two bits say whole (0), first half (1) or second
 * half (2); the low six bits number split packets so halves of different packets don't join.
 */
import dgram from 'node:dgram';
import type { CallTunnelStats } from '../../../shared/callCheck';

export type { CallTunnelStats };

/** The parts of a Hyperswarm connection a tunnel uses. */
export interface TunnelChannel {
  trySend(buffer: Buffer): void;
  on(event: 'message', listener: (message: Buffer) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
  /** The UDX stream; its `mtu` is the largest packet libudx sends on this connection. */
  readonly rawStream?: {
    readonly mtu?: number;
    once?(event: 'mtu-exceeded', listener: () => void): unknown;
  } | null;
}

const TUNNEL_MAGIC = 0x42435431; // "BCT1"
const TUNNEL_HEADER_BYTES = 8;
/** `@hyperswarm/secret-stream`'s `trySend`: an 8-byte counter as the nonce and a 16-byte MAC. */
const SECRETBOX_BYTES = 24;
/**
 * libudx's stream MTU counts the whole IP packet, so a message also carries libudx's 20-byte
 * header and the UDP and IP headers (`UDX_IPV6_HEADER_SIZE`, 40 + 8 + 20, in libudx's udx.h).
 * IPv6's size covers both families. libudx sets don't-fragment and drops an oversized message
 * without an error, so a message must fit.
 */
const PACKET_HEADER_BYTES = 68;
/** Used when the connection doesn't report an MTU: libudx's starting size (`UDX_MTU_BASE`). */
const FALLBACK_MTU = 1200;
export const MAX_TUNNELS_PER_PEER = 8;
const MAX_TUNNEL_ID = 0xffffff;
const PART_WHOLE = 0;
const PART_FIRST = 1;
const PART_SECOND = 2;
/** Split packets waiting for their other half, per tunnel. */
const MAX_PENDING = 16;

/** The largest UDP payload that fits one message on a connection with this MTU. */
export function wholeLimit(mtu: number): number {
  return mtu - PACKET_HEADER_BYTES - SECRETBOX_BYTES - TUNNEL_HEADER_BYTES;
}

export function frame(id: number, part: number, sequence: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(TUNNEL_HEADER_BYTES + payload.byteLength);
  out.writeUInt32BE(TUNNEL_MAGIC, 0);
  out.writeUIntBE(id, 4, 3);
  out.writeUInt8((part << 6) | (sequence & 0x3f), 7);
  payload.copy(out, TUNNEL_HEADER_BYTES);
  return out;
}

export function parseFrame(message: Buffer): { id: number; part: number; sequence: number; payload: Buffer } | null {
  if (message.byteLength < TUNNEL_HEADER_BYTES || message.readUInt32BE(0) !== TUNNEL_MAGIC) return null;
  const byte = message.readUInt8(7);
  const part = byte >> 6;
  if (part > PART_SECOND) return null;
  return { id: message.readUIntBE(4, 3), part, sequence: byte & 0x3f, payload: message.subarray(TUNNEL_HEADER_BYTES) };
}

interface Endpoint {
  id: number;
  socket: dgram.Socket;
  port: number;
  /** WebRTC's address, learned from the first packet. */
  source: { address: string; port: number } | null;
  sequence: number;
  pending: Map<number, { part: number; payload: Buffer }>;
  stats: CallTunnelStats;
}

interface Peer {
  channel: TunnelChannel;
  endpoints: Map<number, Endpoint>;
}

export class CallTunnels {
  private peers = new Map<string, Peer>();

  constructor(private readonly host = '127.0.0.1') {}

  /** Route a peer's tunnel messages. A newer connection replaces the old one; its tunnels carry on. */
  attach(device: string, channel: TunnelChannel): void {
    const existing = this.peers.get(device);
    if (existing) existing.channel = channel;
    else this.peers.set(device, { channel, endpoints: new Map() });
    channel.on('message', (message) => this.receive(device, channel, message));
    channel.rawStream?.once?.('mtu-exceeded', () => {
      for (const endpoint of this.peers.get(device)?.endpoints.values() ?? []) endpoint.stats.dropped++;
    });
    channel.once('close', () => {
      if (this.peers.get(device)?.channel === channel) this.closeDevice(device);
    });
  }

  /** Open an endpoint for one call connection; resolves to its port. */
  async open(device: string, id: number): Promise<number> {
    if (!Number.isInteger(id) || id < 1 || id > MAX_TUNNEL_ID) throw new Error('Bad tunnel id.');
    const peer = this.peers.get(device);
    if (!peer) throw new Error('No connection to that member.');
    const existing = peer.endpoints.get(id);
    if (existing) return existing.port;
    if (peer.endpoints.size >= MAX_TUNNELS_PER_PEER) throw new Error('Too many tunnels to that member.');
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, this.host, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.on('error', () => undefined);
    const endpoint: Endpoint = {
      id,
      socket,
      port: socket.address().port,
      source: null,
      sequence: 0,
      pending: new Map(),
      stats: { mtu: this.mtu(peer), packetsOut: 0, packetsIn: 0, split: 0, dropped: 0, bytesOut: 0, bytesIn: 0 },
    };
    // The peer may have gone while the socket bound.
    if (this.peers.get(device) !== peer) {
      socket.close();
      throw new Error('No connection to that member.');
    }
    peer.endpoints.set(id, endpoint);
    socket.on('message', (payload, from) => this.send(device, endpoint, payload, from));
    return endpoint.port;
  }

  stats(device: string, id: number): CallTunnelStats | null {
    const endpoint = this.peers.get(device)?.endpoints.get(id);
    return endpoint ? { ...endpoint.stats } : null;
  }

  /** Close one endpoint; returns its final counts, or null if it was already gone. */
  close(device: string, id: number): CallTunnelStats | null {
    const peer = this.peers.get(device);
    const endpoint = peer?.endpoints.get(id);
    if (!peer || !endpoint) return null;
    peer.endpoints.delete(id);
    endpoint.socket.close();
    return { ...endpoint.stats };
  }

  /** Devices with an endpoint of this id, for closing by member when the device isn't known. */
  devicesWith(id: number): string[] {
    return [...this.peers].filter(([, peer]) => peer.endpoints.has(id)).map(([device]) => device);
  }

  closeAll(): void {
    for (const device of [...this.peers.keys()]) this.closeDevice(device);
  }

  /** Each peer with an open endpoint: its connection and its endpoints' counts summed. */
  summary(): Array<{ device: string; channel: TunnelChannel; tunnels: number; totals: CallTunnelStats }> {
    const out = [];
    for (const [device, peer] of this.peers) {
      if (peer.endpoints.size === 0) continue;
      const totals: CallTunnelStats = { mtu: this.mtu(peer), packetsOut: 0, packetsIn: 0, split: 0, dropped: 0, bytesOut: 0, bytesIn: 0 };
      for (const { stats } of peer.endpoints.values()) {
        totals.packetsOut += stats.packetsOut;
        totals.packetsIn += stats.packetsIn;
        totals.split += stats.split;
        totals.dropped += stats.dropped;
        totals.bytesOut += stats.bytesOut;
        totals.bytesIn += stats.bytesIn;
      }
      out.push({ device, channel: peer.channel, tunnels: peer.endpoints.size, totals });
    }
    return out;
  }

  /** Endpoints open, for the heartbeat. */
  count(): number {
    let open = 0;
    for (const peer of this.peers.values()) open += peer.endpoints.size;
    return open;
  }

  private closeDevice(device: string): void {
    const peer = this.peers.get(device);
    if (!peer) return;
    this.peers.delete(device);
    for (const endpoint of peer.endpoints.values()) endpoint.socket.close();
  }

  private mtu(peer: Peer): number {
    const mtu = peer.channel.rawStream?.mtu;
    return typeof mtu === 'number' && mtu > 0 ? mtu : FALLBACK_MTU;
  }

  /** A packet from WebRTC: frame it, splitting it in two if it wouldn't fit one message. */
  private send(device: string, endpoint: Endpoint, payload: Buffer, from: dgram.RemoteInfo): void {
    if (!endpoint.source) endpoint.source = { address: from.address, port: from.port };
    else if (endpoint.source.address !== from.address || endpoint.source.port !== from.port) return;
    const peer = this.peers.get(device);
    if (!peer) return;
    endpoint.stats.mtu = this.mtu(peer);
    endpoint.stats.packetsOut++;
    endpoint.stats.bytesOut += payload.byteLength;
    if (payload.byteLength <= wholeLimit(endpoint.stats.mtu)) {
      peer.channel.trySend(frame(endpoint.id, PART_WHOLE, 0, payload));
      return;
    }
    const middle = Math.ceil(payload.byteLength / 2);
    if (middle > wholeLimit(endpoint.stats.mtu)) {
      endpoint.stats.dropped++;
      return;
    }
    const sequence = endpoint.sequence;
    endpoint.sequence = (endpoint.sequence + 1) & 0x3f;
    endpoint.stats.split++;
    peer.channel.trySend(frame(endpoint.id, PART_FIRST, sequence, payload.subarray(0, middle)));
    peer.channel.trySend(frame(endpoint.id, PART_SECOND, sequence, payload.subarray(middle)));
  }

  /** A message from the other Mac: deliver it to WebRTC, joining halves. */
  private receive(device: string, channel: TunnelChannel, message: Buffer): void {
    const parsed = parseFrame(message);
    if (!parsed) return;
    const peer = this.peers.get(device);
    if (!peer || peer.channel !== channel) return;
    const endpoint = peer.endpoints.get(parsed.id);
    if (!endpoint) return;
    let payload = parsed.payload;
    if (parsed.part !== PART_WHOLE) {
      const other = endpoint.pending.get(parsed.sequence);
      if (!other || other.part === parsed.part) {
        if (other) endpoint.stats.dropped++;
        endpoint.pending.set(parsed.sequence, { part: parsed.part, payload: Buffer.from(parsed.payload) });
        if (endpoint.pending.size > MAX_PENDING) {
          const oldest = endpoint.pending.keys().next().value as number;
          endpoint.pending.delete(oldest);
          endpoint.stats.dropped++;
        }
        return;
      }
      endpoint.pending.delete(parsed.sequence);
      payload = parsed.part === PART_SECOND ? Buffer.concat([other.payload, payload]) : Buffer.concat([payload, other.payload]);
    }
    if (!endpoint.source) {
      endpoint.stats.dropped++;
      return;
    }
    endpoint.stats.packetsIn++;
    endpoint.stats.bytesIn += payload.byteLength;
    endpoint.socket.send(payload, endpoint.source.port, endpoint.source.address);
  }
}

/**
 * One `call.tunnel-sample` record: how late the sampler fired, the process's CPU over the
 * interval and its memory, and per peer the Circles connection and its tunnels' counts.
 */
export function tunnelSample(
  peers: ReturnType<CallTunnels['summary']>,
  lagMs: number,
  cpu: { user: number; system: number },
  memory: { rss: number; heapUsed: number },
  intervalMs: number
): Record<string, unknown> {
  return {
    lagMs,
    cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / intervalMs) * 1000) / 10,
    rssMb: Math.round(memory.rss / 2 ** 20),
    heapMb: Math.round(memory.heapUsed / 2 ** 20),
    peers: peers.map(({ device, channel, tunnels, totals }) => {
      const raw = channel.rawStream as { rtt?: number; retransmits?: number } | null | undefined;
      return {
        device: device.slice(0, 8),
        tunnels,
        rttMs: raw?.rtt ?? null,
        retransmits: raw?.retransmits ?? null,
        ...totals,
      };
    }),
  };
}
