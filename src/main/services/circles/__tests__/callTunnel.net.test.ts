import dgram from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CirclesSnapshot } from '../../../../shared/types/circles';
import { CircleNetwork } from '../circleNetwork';

/**
 * Call tunnels between two members over a real Hyperswarm connection on a HyperDHT testnet, with
 * UDP sockets standing in for WebRTC. Packets cross as `trySend` messages. A test that needs a
 * packet to have been handled on the far side waits for that connection's `message` event, which
 * fires after the tunnel's own listener. No test waits on a timer.
 */

interface Person {
  net: CircleNetwork;
  identity: string;
  device: string;
  until(test: (snapshot: CirclesSnapshot) => boolean): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const people: Person[] = [];
const sockets: dgram.Socket[] = [];

async function person(name: string): Promise<Person> {
  const waiters = new Set<() => void>();
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: () => waiters.forEach((wake) => wake()),
  });
  await net.ready();
  const made: Person = {
    net,
    identity: net.identity.publicKey.toString('hex'),
    device: net.device.publicKey.toString('hex'),
    until: (test) =>
      new Promise((resolve) => {
        const check = () => {
          if (!test(net.snapshot())) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      }),
  };
  people.push(made);
  return made;
}

/** Resolves once `at` has handled the next message from `from` on their connection. */
function handled(at: Person, from: Person): Promise<void> {
  const peers = (at.net as unknown as { peers: Map<string, { connection: NodeJS.EventEmitter }> }).peers;
  return new Promise((resolve) => peers.get(from.device)!.connection.once('message', () => resolve()));
}

async function webrtc(): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  sockets.push(socket);
  return socket;
}

const next = (socket: dgram.Socket) =>
  new Promise<{ payload: Buffer; port: number }>((resolve) =>
    socket.once('message', (payload, from) => resolve({ payload, port: from.port }))
  );

const sendTo = (socket: dgram.Socket, port: number, payload: Buffer) =>
  new Promise<void>((resolve, reject) => socket.send(payload, port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-tunnel-'));
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  for (const { net } of people) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Call tunnels over a local DHT', () => {
  let ada: Person;
  let bo: Person;
  let cy: Person;
  let circle: string;

  beforeAll(async () => {
    ada = await person('Ada');
    bo = await person('Bo');
    cy = await person('Cy');
    circle = (await ada.net.createCircle('Calls')).key!;
    await bo.net.joinCircle((await ada.net.createInvite(circle, Date.now() + 60_000)).code);
    const online = (snapshot: CirclesSnapshot) =>
      snapshot.circles.find((entry) => entry.key === circle)?.members.filter((member) => member.online).length === 2;
    await Promise.all([ada.until(online), bo.until(online)]);
  });

  it('carries packets both ways, and a full-size packet whole or split', async () => {
    const adaPort = await ada.net.openCallTunnel(circle, bo.identity, 5);
    const boPort = await bo.net.openCallTunnel(circle, ada.identity, 5);
    const adaRtc = await webrtc();
    const boRtc = await webrtc();

    // Bo's endpoint hasn't seen Bo's WebRTC yet, so Ada's first packet is dropped there.
    const dropped = handled(bo, ada);
    await sendTo(adaRtc, adaPort, Buffer.from('first'));
    await dropped;
    expect(bo.net.callTunnelStats(circle, ada.identity, 5)).toMatchObject({ dropped: 1, packetsIn: 0 });

    const atAda = next(adaRtc);
    await sendTo(boRtc, boPort, Buffer.from('from bo'));
    expect(await atAda).toEqual({ payload: Buffer.from('from bo'), port: adaPort });

    const full = crypto.randomBytes(1200);
    const atBo = next(boRtc);
    await sendTo(adaRtc, adaPort, full);
    const got = await atBo;
    expect(got.payload.equals(full)).toBe(true);
    expect(got.port).toBe(boPort);

    const stats = ada.net.callTunnelStats(circle, bo.identity, 5)!;
    expect(stats.mtu).toBeGreaterThan(0);
    expect(stats).toMatchObject({ packetsOut: 2, packetsIn: 1, split: full.byteLength > stats.mtu - 100 ? 1 : 0 });

    expect(ada.net.callTunnelStats(circle, bo.identity, 5, { close: true })).toMatchObject({ packetsOut: 2 });
    expect(ada.net.callTunnelStats(circle, bo.identity, 5)).toBeNull();
    bo.net.callTunnelStats(circle, ada.identity, 5, { close: true });
  });

  it('describes this network and the Circles connection to a member, by class only', () => {
    const context = ada.net.callContext(circle, bo.identity);
    expect(context.peerConnected).toBe(true);
    expect(['loopback', 'lan']).toContain(context.peerAddr);
    expect(typeof context.natFirewalled).toBe('boolean');
    expect(context.peerMtu).toBeGreaterThan(0);
    expect(context.peerAgeS).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(context)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(() => ada.net.callContext(circle, cy.identity)).toThrow('Not a member of that Circle.');
  });

    it('refuses a tunnel to someone outside the Circle, or to yourself', async () => {
    await expect(ada.net.openCallTunnel(circle, cy.identity, 6)).rejects.toThrow('Not a member of that Circle.');
    await expect(ada.net.openCallTunnel(circle, ada.identity, 6)).rejects.toThrow('That is you.');
    await expect(cy.net.openCallTunnel(circle, ada.identity, 6)).rejects.toThrow('Not a member of that Circle.');
  });
});
