import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_ANSWER_MS, CALL_GONE_MS, CALL_STATE_EVERY_MS, type CallState } from '../calls/callMessages';
import { CallRooms } from '../calls/callRooms';
import { CallSession, type CallTransport, type LinkReport, type LinkState, type PeerLink } from '../calls/callSession';
import { packCallMessage, type CallPart } from '../callSignalParts';

const KEY = 'aa'.repeat(32);
const ADA = 'a1'.repeat(32);
const BO = 'b2'.repeat(32);
const LOW = '1111111111111111';
const HIGH = 'ffffffffffffffff';
const ROOM = 'channel/general';

class FakeLink implements PeerLink {
  remote = { stream: true };
  closed = false;
  tunnels: number[] = [];
  accepted: string[] = [];
  answered: string[] = [];
  offers = 0;
  private listener: ((state: LinkState) => void) | null = null;
  async offer(): Promise<string> {
    this.offers++;
    return 'sdp-offer';
  }
  async answer(remoteSdp: string): Promise<string> {
    this.answered.push(remoteSdp);
    return 'sdp-answer';
  }
  async accept(remoteSdp: string): Promise<void> {
    // As in WebRTC: an answer only fits a link that made an offer.
    if (this.offers === 0) throw new Error('InvalidStateError');
    this.accepted.push(remoteSdp);
  }
  async addTunnel(port: number): Promise<void> {
    this.tunnels.push(port);
  }
  onState(listener: (state: LinkState) => void): void {
    this.listener = listener;
  }
  set(state: LinkState): void {
    this.listener?.(state);
  }
  close(): void {
    this.closed = true;
  }
}

interface Side {
  identity: string;
  session: CallSession;
  rooms: CallRooms;
  links: FakeLink[];
  states: CallState[];
  stateTargets: (string | undefined)[];
  devices: (string | undefined)[];
  /** The device this side's states say they come from. */
  device?: string;
  parts: { to: string; part: CallPart }[];
  tunnels: { action: 'open' | 'close'; to: string; id: number }[];
  /** When false, tunnels refuse to open. */
  tunnelOk: boolean;
  /** When false, this side's parts are not delivered. */
  deliver: boolean;
  /** When true, this side's states are not delivered, as if its Mac went quiet. */
  silent: boolean;
  reports: LinkReport[];
}

/** Let compression, signals and replies run; each hop takes a few turns of the event loop. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await vi.advanceTimersByTimeAsync(0);
}

/** Sides joined to one fake Circle: states reach every other side's rooms, parts reach the side they're for. */
function circle(specs: { identity: string; session: string; with?: string }[]): Side[] {
  const sides: Side[] = [];
  for (const spec of specs) {
    const rooms = new CallRooms();
    const side = { identity: spec.identity, rooms, links: [], states: [], stateTargets: [], devices: [], parts: [], tunnels: [], tunnelOk: true, deliver: true, silent: false, reports: [] } as unknown as Side;
    const transport: CallTransport = {
      sendState: (circleKey, state, to) => {
        side.states.push(state);
        side.stateTargets.push(to);
        if (side.silent) return;
        for (const other of sides) if (other !== side && (!to || other.identity === to)) other.rooms.see(circleKey, side.identity, state, Date.now(), side.device);
      },
      sendPart: async (_circleKey, to, part) => {
        side.parts.push({ to, part });
        if (!side.deliver) return true;
        for (const other of sides) if (other !== side && other.identity === to) void other.session.receivePart(side.identity, part);
        return true;
      },
      tunnel: async (action, _circleKey, to, id, device) => {
        side.devices.push(device);
        side.tunnels.push({ action, to, id });
        return action === 'open' && side.tunnelOk ? 50_000 + (id % 1000) : null;
      },
    };
    side.session = new CallSession({
      circleKey: KEY,
      room: ROOM,
      me: spec.identity,
      transport,
      rooms,
      session: spec.session,
      with: spec.with,
      report: (report) => side.reports.push(report),
      newPeer: () => {
        const link = new FakeLink();
        side.links.push(link);
        return link;
      },
    });
    sides.push(side);
  }
  return sides;
}

const offersSent = (side: Side) => side.links.reduce((sum, link) => sum + link.offers, 0);

/**
 * Node's CompressionStream finishes on the thread pool, outside fake timers, so these tests swap
 * in a pass-through stream: every hop is then promise work that `flush` drains. Real compression
 * is covered in callSignalParts.test.ts.
 */
class PassThrough {
  constructor() {
    return new TransformStream();
  }
}

describe('CallSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('CompressionStream', PassThrough);
    vi.stubGlobal('DecompressionStream', PassThrough);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('announces itself at once and every 5 seconds, and lists its own room', async () => {
    const [ada] = circle([{ identity: ADA, session: LOW }]);
    ada.session.start();
    expect(ada.states).toEqual([{ room: ROOM, s: LOW, muted: false, camera: false, peers: 0 }]);
    expect(ada.rooms.people(KEY, ROOM).map((person) => person.s)).toEqual([LOW]);
    await vi.advanceTimersByTimeAsync(CALL_STATE_EVERY_MS);
    expect(ada.states).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CALL_STATE_EVERY_MS * 3);
    expect(ada.states).toHaveLength(5);
    ada.session.leave();
  });

  it('offers only to sessions with a larger id', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    expect(offersSent(ada)).toBe(1);
    expect(offersSent(bo)).toBe(0);
    expect(bo.links[0].answered).toEqual(['sdp-offer']);
    expect(ada.links[0].accepted).toEqual(['sdp-answer']);
    expect(ada.session.participants.map((p) => p.state)).toEqual(['connecting']);
    ada.links[0].set('connected');
    bo.links[0].set('connected');
    expect(ada.session.participants).toEqual([
      { key: `${BO}/${HIGH}`, identity: BO, s: HIGH, muted: false, camera: false, state: 'connected', remote: { stream: true } },
    ]);
    expect(bo.session.participants.map((p) => [p.key, p.state])).toEqual([[`${ADA}/${LOW}`, 'connected']]);
  });

  it('treats two devices of one person as two participants, and ignores an offer meant for the other device', async () => {
    const MID = '5555555555555555';
    const [ada, boMac, boLaptop] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: MID },
      { identity: BO, session: HIGH },
    ]);
    boMac.session.start();
    boLaptop.session.start();
    ada.session.start();
    await flush();
    expect(ada.session.participants.map((p) => p.key).sort()).toEqual([`${BO}/${MID}`, `${BO}/${HIGH}`]);
    // One person's two devices don't call each other.
    expect(boMac.session.participants.map((p) => p.key)).toEqual([`${ADA}/${LOW}`]);
    expect(boLaptop.session.participants.map((p) => p.key)).toEqual([`${ADA}/${LOW}`]);
    // Every offer to Bo reaches both of Bo's devices; each answers only its own.
    expect(boMac.links.filter((link) => link.answered.length > 0)).toHaveLength(1);
    expect(boLaptop.links.filter((link) => link.answered.length > 0)).toHaveLength(1);
    expect(ada.links.every((link) => link.accepted.length === 1)).toBe(true);
  });

  it("goes on without a tunnel when it can't open", async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    ada.tunnelOk = false;
    bo.session.start();
    ada.session.start();
    await flush();
    expect(ada.links[0].accepted).toEqual(['sdp-answer']);
    expect(ada.links[0].tunnels).toEqual([]);
    expect(bo.tunnels).toEqual([]);
    expect(bo.links[0].tunnels).toEqual([]);
  });

  it('opens the same tunnel id on the answering side and adds it after the offer', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    const opened = ada.tunnels.find((call) => call.action === 'open')!;
    expect(opened.to).toBe(BO);
    expect(bo.tunnels).toEqual([{ action: 'open', to: ADA, id: opened.id }]);
    expect(ada.links[0].tunnels).toEqual([50_000 + (opened.id % 1000)]);
    expect(bo.links[0].tunnels).toEqual([50_000 + (opened.id % 1000)]);
  });

  it('marks someone unreachable when no answer comes in 20 seconds, and retry offers again', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    ada.deliver = false;
    bo.session.start();
    ada.session.start();
    await flush();
    await vi.advanceTimersByTimeAsync(CALL_ANSWER_MS - 1);
    expect(ada.session.participants[0].state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(ada.session.participants[0].state).toBe('unreachable');
    expect(ada.links[0].closed).toBe(true);
    expect(ada.tunnels.filter((call) => call.action === 'close')).toHaveLength(1);
    ada.deliver = true;
    ada.session.retry(`${BO}/${HIGH}`);
    await flush();
    expect(ada.session.participants[0].state).toBe('connecting');
    expect(ada.links).toHaveLength(2);
    expect(ada.links[1].accepted).toEqual(['sdp-answer']);
  });

  it('both sides pressing Try again at once still connects', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    ada.deliver = false;
    bo.deliver = false;
    bo.session.start();
    ada.session.start();
    await flush();
    await vi.advanceTimersByTimeAsync(CALL_ANSWER_MS);
    expect(ada.session.participants[0].state).toBe('unreachable');
    expect(bo.session.participants[0].state).toBe('unreachable');
    ada.deliver = true;
    bo.deliver = true;
    ada.session.retry(`${BO}/${HIGH}`);
    bo.session.retry(`${ADA}/${LOW}`);
    await flush();
    ada.links.at(-1)!.set('connected');
    bo.links.at(-1)!.set('connected');
    expect(ada.session.participants[0].state).toBe('connected');
    expect(bo.session.participants[0].state).toBe('connected');
  });

  it('marks someone unreachable when a part never arrives', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.deliver = false;
    bo.session.start();
    ada.session.start();
    await flush();
    // Bo's answer is long enough to need two parts; only the first reaches Ada.
    const long = Array.from({ length: 3_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('');
    const packed = await packCallMessage({ t: 'answer', room: ROOM, s: HIGH, to: LOW, sdp: long });
    expect(packed.parts.length).toBeGreaterThan(1);
    await ada.session.receivePart(BO, packed.parts[0]);
    await vi.advanceTimersByTimeAsync(CALL_ANSWER_MS);
    expect(ada.session.participants[0].state).toBe('unreachable');
    expect(ada.links[0].accepted).toEqual([]);
  });

  it('marks the answering side unreachable when no offer comes', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    ada.deliver = false;
    bo.session.start();
    ada.session.start();
    await flush();
    expect(bo.session.participants[0].state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(CALL_ANSWER_MS);
    expect(bo.session.participants[0].state).toBe('unreachable');
  });

  it('drops a participant whose state stops for 15 seconds and closes its link and tunnel', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    ada.links[0].set('connected');
    // Bo's Mac goes quiet without a goodbye.
    bo.silent = true;
    await vi.advanceTimersByTimeAsync(CALL_GONE_MS + CALL_STATE_EVERY_MS);
    expect(ada.session.participants).toEqual([]);
    expect(ada.links[0].closed).toBe(true);
    expect(ada.tunnels.filter((call) => call.action === 'close').map((call) => call.to)).toEqual([BO]);
  });

  it('leaving sends bye and a left state, closes links and tunnels, and ignores later parts', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    ada.session.leave();
    await flush();
    expect(ada.states.at(-1)).toEqual({ room: ROOM, s: LOW, muted: false, camera: false, peers: 0, left: true });
    expect(ada.links[0].closed).toBe(true);
    expect(ada.tunnels.filter((call) => call.action === 'close')).toHaveLength(1);
    expect(bo.session.participants).toEqual([]);
    expect(bo.links[0].closed).toBe(true);
    const later = await packCallMessage({ t: 'offer', room: ROOM, s: HIGH, to: LOW, sdp: 'v=0' });
    await ada.session.receivePart(BO, later.parts[0]);
    expect(ada.links).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CALL_STATE_EVERY_MS * 2);
    expect(ada.states.at(-1)?.left).toBe(true);
  });

  it('leaving while an offer waits for its answer closes that link and sends nothing later', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    ada.deliver = false;
    bo.session.start();
    ada.session.start();
    await flush();
    const sentBefore = ada.parts.length;
    ada.session.leave();
    await flush();
    expect(ada.links[0].closed).toBe(true);
    const sentAtLeave = ada.parts.length;
    expect(sentAtLeave).toBeGreaterThan(sentBefore); // the goodbye
    await vi.advanceTimersByTimeAsync(CALL_ANSWER_MS * 2);
    expect(ada.parts.length).toBe(sentAtLeave);
    expect(ada.session.participants).toEqual([]);
  });

  it('leaving while an offer is being sent stops the rest of it', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    // An offer long enough to need two parts.
    const long = Array.from({ length: 3_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join('');
    vi.spyOn(FakeLink.prototype, 'offer').mockResolvedValue(long);
    ada.deliver = false;
    let firstId: string | null = null;
    const sendPart = ada.session['transport'].sendPart;
    ada.session['transport'].sendPart = async (key, to, part) => {
      firstId ??= part.id;
      const sent = await sendPart(key, to, part);
      if (part.id === firstId && part.n === 0) ada.session.leave();
      return sent;
    };
    bo.session.start();
    ada.session.start();
    await flush();
    expect(ada.parts.filter(({ part }) => part.id === firstId)).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("a bye closes that person's link", async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    const bye = await packCallMessage({ t: 'bye', room: ROOM, s: HIGH, to: LOW });
    await ada.session.receivePart(BO, bye.parts[0]);
    expect(ada.links[0].closed).toBe(true);
    expect(ada.session.participants).toEqual([]);
  });

  it('sends state at once when muted or camera changes', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    const before = ada.states.length;
    ada.session.setMuted(true);
    ada.session.setCamera(true);
    expect(ada.states.slice(before)).toEqual([
      { room: ROOM, s: LOW, muted: true, camera: false, peers: 0 },
      { room: ROOM, s: LOW, muted: true, camera: true, peers: 0 },
    ]);
    expect(bo.session.participants[0]).toMatchObject({ muted: true, camera: true });
  });

  it('marks a failed link unreachable', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    let changes = 0;
    ada.session.onChange(() => changes++);
    ada.links[0].set('failed');
    expect(ada.session.participants[0].state).toBe('unreachable');
    expect(changes).toBeGreaterThan(0);
  });

  it('reports a connection with its role and setup time, and its end with how long it lasted', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1_500);
    ada.links[0].set('connected');
    bo.links[0].set('connected');
    ada.links[0].set('connected');
    expect(ada.reports).toEqual([
      { kind: 'connected', key: `${BO}/${HIGH}`, identity: BO, role: 'offer', ms: 1_500, link: ada.links[0] },
    ]);
    expect(bo.reports.map((report) => [report.kind, report.kind === 'connected' && report.role])).toEqual([['connected', 'answer']]);
    await vi.advanceTimersByTimeAsync(60_000);
    ada.session.leave();
    expect(ada.reports[1]).toEqual({ kind: 'ended', key: `${BO}/${HIGH}`, identity: BO, seconds: 60, link: ada.links[0] });
  });

  it('reports no end for a link that never connected', async () => {
    const [ada, bo] = circle([
      { identity: ADA, session: LOW },
      { identity: BO, session: HIGH },
    ]);
    bo.session.start();
    ada.session.start();
    await flush();
    ada.session.leave();
    expect(ada.reports).toEqual([]);
  });

  describe('private rooms', () => {
    const CY = 'c3'.repeat(32);
    const DEVICE = 'd4'.repeat(32);
    const MID = '5555555555555555';

    it('a private room sends state only to the other person', async () => {
      const [ada, bo, cy] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
        { identity: CY, session: MID },
      ]);
      ada.session.start();
      await flush();
      expect(ada.stateTargets.every((to) => to === BO)).toBe(true);
      expect(cy.rooms.people(KEY, ROOM)).toEqual([]);
      expect(bo.rooms.people(KEY, ROOM)).toHaveLength(1);
      ada.session.leave();
    });

    it('a private room ignores a third person in it', async () => {
      const [ada, , cy] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
        { identity: CY, session: MID },
      ]);
      ada.session.start();
      cy.session.start();
      await flush();
      expect(ada.session.participants).toEqual([]);
      expect(offersSent(ada)).toBe(0);
      expect(ada.parts.every((sent) => sent.to !== CY)).toBe(true);
      ada.session.leave();
      cy.session.leave();
    });

    it('a private room ignores an offer from a third person', async () => {
      const [ada] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
        { identity: CY, session: MID },
      ]);
      ada.session.start();
      await flush();
      const offer = await packCallMessage({ t: 'offer', room: ROOM, s: MID, to: LOW, sdp: 'v=0' });
      for (const part of offer.parts) await ada.session.receivePart(CY, part);
      await flush();
      expect(ada.session.participants).toEqual([]);
      expect(ada.links).toHaveLength(0);
      expect(ada.parts).toEqual([]);
      ada.session.leave();
    });

    it('a private room ends once the other person leaves after connecting', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
      ]);
      const changes = vi.fn();
      ada.session.onChange(changes);
      bo.session.start();
      ada.session.start();
      await flush();
      ada.links[0].set('connected');
      expect(ada.session.over).toBe(false);
      bo.session.leave();
      await flush();
      expect(ada.session.over).toBe(true);
      expect(ada.states.at(-1)).toMatchObject({ left: true });
      expect(changes).toHaveBeenCalled();
    });

    it("a private room doesn't end before the person arrives", async () => {
      const [ada] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
      ]);
      ada.session.start();
      await flush();
      await vi.advanceTimersByTimeAsync(CALL_GONE_MS + CALL_STATE_EVERY_MS);
      expect(ada.session.participants).toEqual([]);
      expect(ada.session.over).toBe(false);
      ada.session.leave();
    });

    it('a private room ends when the person leaves without ever connecting', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
      ]);
      bo.session.start();
      ada.session.start();
      await flush();
      expect(ada.session.participants).toHaveLength(1);
      bo.session.leave();
      await flush();
      expect(ada.session.over).toBe(true);
      expect(ada.states.at(-1)).toMatchObject({ left: true });
    });

    it('a private room ends when the person goes quiet without ever connecting', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW, with: BO },
        { identity: BO, session: HIGH, with: ADA },
      ]);
      bo.session.start();
      ada.session.start();
      await flush();
      bo.silent = true;
      await vi.advanceTimersByTimeAsync(CALL_GONE_MS + CALL_STATE_EVERY_MS);
      expect(ada.session.over).toBe(true);
      bo.session.leave();
    });

    it('a room that is not private never ends by itself', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW },
        { identity: BO, session: HIGH },
      ]);
      bo.session.start();
      ada.session.start();
      await flush();
      ada.links[0].set('connected');
      bo.session.leave();
      await flush();
      expect(ada.session.over).toBe(false);
      ada.session.leave();
    });

    it('opens the tunnel to the device that sent the state', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW },
        { identity: BO, session: HIGH },
      ]);
      ada.device = CY;
      bo.device = DEVICE;
      ada.session.start();
      bo.session.start();
      await flush();
      expect(ada.devices).toContain(DEVICE);
      expect(bo.devices).toContain(CY);
      expect(ada.session.participants[0].device).toBe(DEVICE);
    });

    it('opens the answering tunnel to the device in the room when the offer comes first', async () => {
      const [, bo] = circle([
        { identity: ADA, session: LOW },
        { identity: BO, session: HIGH },
      ]);
      // The room has Ada's state, but Bo's session has no peer for her yet when her offer lands.
      bo.rooms.see(KEY, ADA, { room: ROOM, s: LOW, muted: false, camera: false }, Date.now(), CY);
      const packed = await packCallMessage({ t: 'offer', room: ROOM, s: LOW, to: HIGH, sdp: 'sdp-offer', tunnel: 7 });
      for (const part of packed.parts) await bo.session.receivePart(ADA, part);
      await flush();
      const opens = bo.tunnels.map((call, index) => ({ ...call, device: bo.devices[index] })).filter((call) => call.action === 'open');
      expect(opens).toHaveLength(1);
      expect(opens[0].device).toBe(CY);
    });

    it('closes a tunnel on the device it opened on', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW },
        { identity: BO, session: HIGH },
      ]);
      ada.device = CY;
      bo.device = DEVICE;
      ada.session.start();
      bo.session.start();
      await flush();
      // Bo's state now names another device; the open tunnel is still on the first one.
      ada.rooms.see(KEY, BO, { room: ROOM, s: HIGH, muted: false, camera: false }, Date.now(), CY);
      await flush();
      ada.session.leave();
      await flush();
      const closes = ada.tunnels.map((call, index) => ({ ...call, device: ada.devices[index] })).filter((call) => call.action === 'close');
      expect(closes).toHaveLength(1);
      expect(closes[0].device).toBe(DEVICE);
    });

    it('state carries how many people are connected', async () => {
      const [ada, bo] = circle([
        { identity: ADA, session: LOW },
        { identity: BO, session: HIGH },
      ]);
      bo.session.start();
      ada.session.start();
      await flush();
      expect(ada.states.at(-1)?.peers).toBe(0);
      const before = ada.states.length;
      ada.links[0].set('connected');
      expect(ada.states.length).toBe(before + 1);
      expect(ada.states.at(-1)?.peers).toBe(1);
      ada.session.leave();
      bo.session.leave();
    });
  });
});
