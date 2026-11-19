import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CallTunnels,
  MAX_TUNNELS_PER_PEER,
  frame,
  tunnelSample,
  parseFrame,
  wholeLimit,
  type TunnelChannel,
} from '../callTunnel';
import { probeMessage } from '../unorderedProbe';

/** One end of a fake Hyperswarm connection; `trySend` delivers to the linked end. */
class FakeChannel extends EventEmitter implements TunnelChannel {
  other: FakeChannel | null = null;
  sent: Buffer[] = [];
  rawStream: { mtu?: number } | null;
  constructor(mtu?: number) {
    super();
    this.rawStream = mtu === undefined ? null : { mtu };
  }
  trySend(buffer: Buffer): void {
    this.sent.push(buffer);
    const other = this.other;
    if (other) setImmediate(() => other.emit('message', Buffer.from(buffer)));
  }
}

function link(mtu?: number): [FakeChannel, FakeChannel] {
  const a = new FakeChannel(mtu);
  const b = new FakeChannel(mtu);
  a.other = b;
  b.other = a;
  return [a, b];
}

const sockets: dgram.Socket[] = [];
const tunnels: CallTunnels[] = [];

/** A stand-in for WebRTC's socket. */
async function webrtc(): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  sockets.push(socket);
  return socket;
}

function next(socket: dgram.Socket): Promise<{ payload: Buffer; port: number }> {
  return new Promise((resolve) => socket.once('message', (payload, from) => resolve({ payload, port: from.port })));
}

function sendTo(socket: dgram.Socket, port: number, payload: Buffer): Promise<void> {
  return new Promise((resolve, reject) => socket.send(payload, port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));
}

/** Two Macs' tunnels joined by a fake connection, each with one endpoint for tunnel 7. */
async function pair(mtu?: number) {
  const [channelA, channelB] = link(mtu);
  const macA = new CallTunnels();
  const macB = new CallTunnels();
  tunnels.push(macA, macB);
  macA.attach('device-b', channelA);
  macB.attach('device-a', channelB);
  const portA = await macA.open('device-b', 7);
  const portB = await macB.open('device-a', 7);
  const rtcA = await webrtc();
  const rtcB = await webrtc();
  return { channelA, channelB, macA, macB, portA, portB, rtcA, rtcB };
}

/** Both sides send once, so each endpoint knows its WebRTC's address. */
async function introduce(p: Awaited<ReturnType<typeof pair>>) {
  // The tunnel's listener was added first, so B has handled the message when this one runs.
  const reachedB = new Promise((resolve) => p.channelB.once('message', resolve));
  await sendTo(p.rtcA, p.portA, Buffer.from('hello from a'));
  await reachedB;
  const atA = next(p.rtcA);
  await sendTo(p.rtcB, p.portB, Buffer.from('hello from b'));
  return atA;
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const tunnel of tunnels.splice(0)) tunnel.closeAll();
});

describe('call tunnel', () => {
  it('frames and parses a message, and ignores other messages on the connection', () => {
    const message = frame(0xabcdef, 2, 5, Buffer.from('rtp'));
    expect(parseFrame(message)).toEqual({ id: 0xabcdef, part: 2, sequence: 5, payload: Buffer.from('rtp') });
    expect(parseFrame(probeMessage(3))).toBeNull();
    expect(parseFrame(Buffer.alloc(4))).toBeNull();
    expect(wholeLimit(1200)).toBe(1100);
  });

  it('carries packets both ways, from the endpoint WebRTC was given', async () => {
    const p = await pair();
    const first = await introduce(p);
    // A's first packet arrived before B had sent anything, so only B's reached A.
    expect(first.payload.toString()).toBe('hello from b');
    expect(first.port).toBe(p.portA);
    expect(p.macB.stats('device-a', 7)).toMatchObject({ packetsOut: 1, packetsIn: 0, dropped: 1 });

    const atB = next(p.rtcB);
    await sendTo(p.rtcA, p.portA, Buffer.from('media'));
    const got = await atB;
    expect(got.payload.toString()).toBe('media');
    expect(got.port).toBe(p.portB);
    expect(p.macA.stats('device-b', 7)).toMatchObject({ mtu: 1200, packetsOut: 2, packetsIn: 1, split: 0, bytesOut: 17, bytesIn: 12 });
  });

  it('sums each peer’s tunnels into a sample with the process’s CPU and memory', async () => {
    const p = await pair();
    await introduce(p);
    await p.macA.open('device-b', 8);
    const peers = p.macA.summary();
    expect(peers.map(({ device, tunnels }) => ({ device, tunnels }))).toEqual([{ device: 'device-b', tunnels: 2 }]);
    p.channelA.rawStream = { mtu: 1200, rtt: 41, retransmits: 3 } as never;
    expect(tunnelSample(peers, 12, { user: 400_000, system: 100_000 }, { rss: 300 * 2 ** 20, heapUsed: 80 * 2 ** 20 }, 5_000)).toEqual({
      lagMs: 12,
      cpuPct: 10,
      rssMb: 300,
      heapMb: 80,
      peers: [
        { device: 'device-b', tunnels: 2, rttMs: 41, retransmits: 3, mtu: 1200, packetsOut: 1, packetsIn: 1, split: 0, dropped: 0, bytesOut: 12, bytesIn: 12 },
      ],
    });
  });

  it('splits a packet too big for one message and joins it on the other side', async () => {
    const p = await pair(800);
    await introduce(p);
    const big = Buffer.alloc(1200, 7);
    big.write('start', 0);
    const atB = next(p.rtcB);
    await sendTo(p.rtcA, p.portA, big);
    expect((await atB).payload.equals(big)).toBe(true);
    expect(p.macA.stats('device-b', 7)).toMatchObject({ mtu: 800, split: 1 });
    // Each half, once boxed and inside libudx, UDP and IPv6 headers, fits the 800-byte MTU.
    for (const message of p.channelA.sent.slice(-2)) expect(message.byteLength + 24 + 68).toBeLessThanOrEqual(800);
  });

  it('drops a packet whose halves would still not fit', async () => {
    const p = await pair(600);
    await introduce(p);
    const sent = p.channelA.sent.length;
    const atB = next(p.rtcB);
    await sendTo(p.rtcA, p.portA, Buffer.alloc(1200));
    await sendTo(p.rtcA, p.portA, Buffer.from('small'));
    expect((await atB).payload.toString()).toBe('small');
    expect(p.channelA.sent.length).toBe(sent + 1);
    expect(p.macA.stats('device-b', 7)).toMatchObject({ dropped: 1, split: 0 });
  });

  it('joins halves that arrive second first, and drops a half that never meets its pair', async () => {
    const p = await pair();
    await introduce(p);
    const atA = next(p.rtcA);
    p.channelA.emit('message', frame(7, 2, 3, Buffer.from('-two')));
    p.channelA.emit('message', frame(7, 1, 3, Buffer.from('one')));
    expect((await atA).payload.toString()).toBe('one-two');
    p.channelA.emit('message', frame(7, 1, 4, Buffer.from('lost pair')));
    p.channelA.emit('message', frame(7, 1, 4, Buffer.from('again')));
    expect(p.macA.stats('device-b', 7)).toMatchObject({ dropped: 1 });
  });

  it('ignores packets from a second source', async () => {
    const p = await pair();
    await introduce(p);
    const intruder = await webrtc();
    await sendTo(intruder, p.portA, Buffer.from('not webrtc'));
    const atB = next(p.rtcB);
    await sendTo(p.rtcA, p.portA, Buffer.from('webrtc'));
    expect((await atB).payload.toString()).toBe('webrtc');
    expect(p.macA.stats('device-b', 7)).toMatchObject({ packetsOut: 2 });
  });

  it('refuses a bad id, an unknown device and more than the cap per peer', async () => {
    const [channel] = link();
    const mac = new CallTunnels();
    tunnels.push(mac);
    mac.attach('device-b', channel);
    await expect(mac.open('device-b', 0)).rejects.toThrow('Bad tunnel id.');
    await expect(mac.open('device-b', 0x1000000)).rejects.toThrow('Bad tunnel id.');
    await expect(mac.open('device-c', 1)).rejects.toThrow('No connection to that member.');
    for (let id = 1; id <= MAX_TUNNELS_PER_PEER; id++) await mac.open('device-b', id);
    expect(await mac.open('device-b', 1)).toBeGreaterThan(0);
    await expect(mac.open('device-b', 99)).rejects.toThrow('Too many tunnels to that member.');
    expect(mac.count()).toBe(MAX_TUNNELS_PER_PEER);
    expect(mac.devicesWith(3)).toEqual(['device-b']);
  });

  it('closes a peer’s tunnels when its connection closes, but not when a newer one replaced it', async () => {
    const [first] = link();
    const [second] = link();
    const mac = new CallTunnels();
    tunnels.push(mac);
    mac.attach('device-b', first);
    await mac.open('device-b', 1);
    mac.attach('device-b', second);
    first.emit('close');
    expect(mac.count()).toBe(1);
    second.emit('close');
    expect(mac.count()).toBe(0);
    expect(mac.stats('device-b', 1)).toBeNull();
    expect(mac.close('device-b', 1)).toBeNull();
  });

  it('returns final counts when closed', async () => {
    const p = await pair();
    await introduce(p);
    expect(p.macA.close('device-b', 7)).toMatchObject({ packetsOut: 1, packetsIn: 1 });
    expect(p.macA.count()).toBe(0);
  });
});
