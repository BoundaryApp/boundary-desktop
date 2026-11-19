import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CirclesSnapshot } from '../../../../shared/types/circles';
import { isCallPart } from '../../../../shared/callSignalParts';
import { CALL_PART_TOPIC, CALL_STATE_TOPIC, cleanCallState } from '../../../../shared/calls/callMessages';
import { CallRooms } from '../../../../shared/calls/callRooms';
import { CallSession, type LinkState, type PeerLink } from '../../../../shared/calls/callSession';
import { CircleNetwork } from '../circleNetwork';
import type { CircleSignal } from '../circleSignals';

/**
 * Three devices join one call room over a HyperDHT testnet, with call setup going over real peer
 * signals and real tunnels. Media is faked: a link reports connected once its offer or answer has
 * gone through, which is what the session controls. No test waits on a timer.
 */

class FakeLink implements PeerLink {
  remote: unknown = null;
  closed = false;
  offers = 0;
  tunnels: number[] = [];
  private listener: ((state: LinkState) => void) | null = null;
  async offer(): Promise<string> {
    this.offers++;
    return 'v=0 offer';
  }
  async answer(): Promise<string> {
    queueMicrotask(() => this.listener?.('connected'));
    return 'v=0 answer';
  }
  async accept(): Promise<void> {
    queueMicrotask(() => this.listener?.('connected'));
  }
  async addTunnel(port: number): Promise<void> {
    this.tunnels.push(port);
  }
  onState(listener: (state: LinkState) => void): void {
    this.listener = listener;
  }
  close(): void {
    this.closed = true;
  }
}

interface Device {
  net: CircleNetwork;
  identity: string;
  rooms: CallRooms;
  links: FakeLink[];
  session: CallSession | null;
  until(test: (snapshot: CirclesSnapshot) => boolean): Promise<CirclesSnapshot>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
const devices: Device[] = [];

async function device(name: string): Promise<Device> {
  const waiters = new Set<() => void>();
  const made = { rooms: new CallRooms(), links: [], session: null } as unknown as Device;
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: () => waiters.forEach((wake) => wake()),
    onSignal: (signal: CircleSignal) => {
      if (signal.topic === CALL_STATE_TOPIC) {
        const state = cleanCallState(signal.payload);
        if (state) made.rooms.see(signal.circle, signal.from, state, Date.now(), signal.device);
      } else if (signal.topic === CALL_PART_TOPIC && isCallPart(signal.payload)) {
        void made.session?.receivePart(signal.from, signal.payload);
      }
    },
  });
  await net.ready();
  net.setSignalTopics([CALL_STATE_TOPIC, CALL_PART_TOPIC]);
  Object.assign(made, {
    net,
    identity: net.identity.publicKey.toString('hex'),
    until: (test: (snapshot: CirclesSnapshot) => boolean) =>
      new Promise<CirclesSnapshot>((resolve) => {
        const check = () => {
          const snapshot = net.snapshot();
          if (!test(snapshot)) return;
          waiters.delete(check);
          resolve(snapshot);
        };
        waiters.add(check);
        check();
      }),
  });
  devices.push(made);
  return made;
}

function join(who: Device, circle: string): CallSession {
  const session = new CallSession({
    circleKey: circle,
    room: 'channel/general',
    me: who.identity,
    rooms: who.rooms,
    newPeer: () => {
      const link = new FakeLink();
      who.links.push(link);
      return link;
    },
    transport: {
      sendState: (key, state) => void who.net.sendSignal(key, CALL_STATE_TOPIC, state),
      sendPart: async (key, to, part) => who.net.sendSignal(key, CALL_PART_TOPIC, part, to) > 0,
      tunnel: async (action, key, to, id, device) => {
        if (action === 'open') return who.net.openCallTunnel(key, to, id, device).catch((): null => null);
        who.net.callTunnelStats(key, to, id, { close: true });
        return null;
      },
    },
  });
  who.session = session;
  return session;
}

/** Resolves once `test` holds for the session, checked on every change. */
function settled(session: CallSession, test: (session: CallSession) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!test(session)) return;
      stop();
      resolve();
    };
    const stop = session.onChange(check);
    check();
  });
}

const connectedTo = (session: CallSession) =>
  session.participants.filter((participant) => participant.state === 'connected').map((participant) => participant.identity);

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-calls-'));
});

afterAll(async () => {
  for (const { session } of devices) session?.leave();
  for (const { net } of devices) await net.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('Calls over a local DHT', () => {
  it('three devices join a room, connect in pairs, and one leaves', async () => {
    const ada = await device('Ada');
    const bo = await device('Bo');
    const cy = await device('Cy');
    const circle = (await ada.net.createCircle('Calls')).key!;
    await bo.net.joinCircle((await ada.net.createInvite(circle, Date.now() + 60_000)).code);
    await cy.net.joinCircle((await ada.net.createInvite(circle, Date.now() + 60_000)).code);
    const online = (snapshot: CirclesSnapshot) =>
      snapshot.circles.find((entry) => entry.key === circle)?.members.filter((member) => member.online).length === 3;
    await Promise.all([ada.until(online), bo.until(online), cy.until(online)]);

    const sessions = [ada, bo, cy].map((who) => join(who, circle));
    for (const session of sessions) session.start();
    await Promise.all(sessions.map((session) => settled(session, (s) => connectedTo(s).length === 2)));

    expect(connectedTo(sessions[0]).sort()).toEqual([bo.identity, cy.identity].sort());
    expect(connectedTo(sessions[1]).sort()).toEqual([ada.identity, cy.identity].sort());
    expect(connectedTo(sessions[2]).sort()).toEqual([ada.identity, bo.identity].sort());
    // One offer per pair.
    expect([ada, bo, cy].reduce((sum, who) => sum + who.links.reduce((n, link) => n + link.offers, 0), 0)).toBe(3);
    // Every link got its tunnel on both ends.
    for (const who of [ada, bo, cy]) {
      for (const link of who.links) expect(link.tunnels).toEqual([expect.any(Number)]);
    }

    const cyLinksSeen = (who: Device) => who.links.filter((link) => link.tunnels.length > 0);
    sessions[2].leave();
    await Promise.all(
      [sessions[0], sessions[1]].map((session) => settled(session, (s) => s.participants.length === 1))
    );
    expect(sessions[0].participants.map((p) => p.identity)).toEqual([bo.identity]);
    expect(sessions[1].participants.map((p) => p.identity)).toEqual([ada.identity]);
    // Ada's and Bo's links to Cy are closed; the one between them is open.
    for (const who of [ada, bo]) {
      const closed = cyLinksSeen(who).filter((link) => link.closed);
      expect(closed).toHaveLength(1);
    }
    expect(cy.links.every((link) => link.closed)).toBe(true);
  }, 60_000);
});
