import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as unknown[][]);
const handlers = vi.hoisted(() => new Map<string, (signal: { circleKey: string; fromIdentity: string; fromDevice: string; payload: unknown }) => void>());
const broadcasts = vi.hoisted(() => [] as unknown[][]);
const diags = vi.hoisted(() => [] as unknown[][]);
const tunnelCalls = vi.hoisted(() => [] as unknown[][]);
const contextCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../circlesService', () => ({
  callTunnel: async (...args: unknown[]) => {
    tunnelCalls.push(args);
    return { success: true, port: 50123 };
  },
  getCirclesState: () => ({ status: 'running' }),
  getCallContext: async (...args: unknown[]) => {
    contextCalls.push(args);
    return { success: true, context: { natFirewalled: true, natRandomized: false, peerConnected: true, peerAddr: 'public', peerRttMs: 42 } };
  },
  sendCircleSignal: (...args: unknown[]) => {
    sent.push(args);
    return true;
  },
  onCircleSignal: (topic: string, handler: (signal: { circleKey: string; fromIdentity: string; fromDevice: string; payload: unknown }) => void) => {
    handlers.set(topic, handler);
    return () => handlers.delete(topic);
  },
}));
vi.mock('../../windows', () => ({ broadcast: (...args: unknown[]) => broadcasts.push(args) }));
vi.mock('../circlesDiagnostics', () => ({ diag: (...args: unknown[]) => diags.push(args) }));
vi.mock('electron', () => ({
  app: {
    getAppMetrics: () => [
      { type: 'Browser', cpu: { percentCPUUsage: 12.34 } },
      { type: 'Tab', cpu: { percentCPUUsage: 3 } },
      { type: 'GPU', cpu: { percentCPUUsage: 1 } },
      { type: 'Utility', cpu: { percentCPUUsage: 2 } },
      { type: 'Utility', cpu: { percentCPUUsage: 0.5 } },
    ],
  },
}));

import {
  callCheckEnabled,
  callTunnelRequest,
  listenForCallSignals,
  listenForCalls,
  logCallEvent,
  sendCallSignal,
  logCallCheckResult,
  logCallCheckSample,
  recordCallCheckResult,
  sendCallCheckSignal,
} from '../callSignals';

const KEY = 'cc'.repeat(32);
const MAYA = 'bb'.repeat(32);
const PART = { t: 'part', id: '0123456789abcdef', n: 0, of: 1, z: 'eA==' };
const DEVICE = 'dd'.repeat(32);
const RING = { t: 'ring', room: 'person/0123456789abcdef' };
const STATE = { room: 'channel/general', s: '0123456789abcdef', muted: false, camera: true };

describe('call signals', () => {
  beforeEach(() => {
    sent.length = 0;
    broadcasts.length = 0;
    diags.length = 0;
    tunnelCalls.length = 0;
    contextCalls.length = 0;
    handlers.clear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does nothing while the check is off', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '');
    expect(callCheckEnabled()).toBe(false);
    expect(sendCallCheckSignal(KEY, MAYA, PART)).toBe(false);
    listenForCallSignals();
    expect(handlers.size).toBe(0);
    expect(logCallCheckResult({ run: '0123abcd', kind: 'connect', mode: 'host', role: 'caller', connected: true })).toBeNull();
    expect(sent).toEqual([]);
    expect(diags).toEqual([]);
  });

  it('opens a tunnel with the check off, for well-formed requests only', async () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '');
    for (const bad of [
      { action: 'delete', key: KEY, to: MAYA, tunnel: 7 },
      { action: 'open', key: 'nope', to: MAYA, tunnel: 7 },
      { action: 'open', key: KEY, to: 'nope', tunnel: 7 },
      { action: 'open', key: KEY, to: MAYA, tunnel: 0 },
      { action: 'open', key: KEY, to: MAYA, tunnel: 0x1000000 },
      { action: 'open', key: KEY, to: MAYA, tunnel: 1.5 },
      null,
    ]) {
      expect(await callTunnelRequest(bad)).toMatchObject({ success: false, error: 'Bad tunnel request.' });
    }
    expect(tunnelCalls).toEqual([]);
    expect(await callTunnelRequest({ action: 'open', key: KEY, to: MAYA, tunnel: 7 })).toEqual({ success: true, port: 50123 });
    expect(tunnelCalls).toEqual([['open', KEY, MAYA, 7, undefined]]);
  });

  it('sends a state to the whole Circle and a part to one member, with the check off', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '');
    expect(sendCallSignal({ key: KEY, topic: 'call.state', state: STATE })).toBe(true);
    expect(sendCallSignal({ key: KEY, topic: 'call.part', to: MAYA, part: PART })).toBe(true);
    expect(sent).toEqual([
      [KEY, 'call.state', STATE],
      [KEY, 'call.part', PART, MAYA],
    ]);
  });

  it("refuses a state with a bad 'to', a part without one, a bad key, a bad state or a bad part", () => {
    for (const bad of [
      { key: KEY, topic: 'call.state', state: STATE, to: 'nope' },
      { key: KEY, topic: 'call.state', state: STATE, to: 7 },
      { key: KEY, topic: 'call.part', part: PART },
      { key: 'nope', topic: 'call.state', state: STATE },
      { key: KEY, topic: 'call.state', state: { ...STATE, room: 'Bad Room' } },
      { key: KEY, topic: 'call.part', to: MAYA, part: { ...PART, n: 3 } },
      { key: KEY, topic: 'call.part', to: 'nope', part: PART },
      { key: KEY, topic: 'call.check', to: MAYA, part: PART },
      null,
    ]) {
      expect(sendCallSignal(bad)).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('sends a state to one member when given a to', () => {
    expect(sendCallSignal({ key: KEY, topic: 'call.state', state: STATE, to: MAYA })).toBe(true);
    expect(sent).toEqual([[KEY, 'call.state', STATE, MAYA]]);
  });

  it("refuses a private room's state without a to", () => {
    const state = { ...STATE, room: 'person/0123456789abcdef' };
    expect(sendCallSignal({ key: KEY, topic: 'call.state', state })).toBe(false);
    expect(sent).toEqual([]);
    expect(sendCallSignal({ key: KEY, topic: 'call.state', state, to: MAYA })).toBe(true);
    expect(sent).toEqual([[KEY, 'call.state', state, MAYA]]);
  });

  it('sends a ring to one member and refuses one without a to', () => {
    expect(sendCallSignal({ key: KEY, topic: 'call.ring', to: MAYA, ring: RING })).toBe(true);
    expect(sent).toEqual([[KEY, 'call.ring', RING, MAYA]]);
    sent.length = 0;
    for (const bad of [
      { key: KEY, topic: 'call.ring', ring: RING },
      { key: KEY, topic: 'call.ring', to: 'nope', ring: RING },
      { key: KEY, topic: 'call.ring', to: MAYA, ring: { ...RING, t: 'shout' } },
      { key: KEY, topic: 'call.ring', to: MAYA, ring: { ...RING, room: 'channel/general' } },
    ]) {
      expect(sendCallSignal(bad)).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('passes rings to the renderer cleaned, and drops bad ones', () => {
    listenForCalls();
    handlers.get('call.ring')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: { ...RING, extra: 1 } });
    handlers.get('call.ring')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: { t: 'ring', room: 'nope' } });
    expect(broadcasts).toEqual([['circles:call', { circleKey: KEY, from: MAYA, device: DEVICE, topic: 'call.ring', ring: RING }]]);
  });

  it('passes the sending device with every call event', () => {
    listenForCalls();
    handlers.get('call.state')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: STATE });
    handlers.get('call.part')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: PART });
    handlers.get('call.ring')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: RING });
    expect(broadcasts.map(([, event]) => (event as { device: string }).device)).toEqual([DEVICE, DEVICE, DEVICE]);
  });

  it('opens a tunnel on a given device, and refuses a device that isn’t 64 hex', async () => {
    expect(await callTunnelRequest({ action: 'open', key: KEY, to: MAYA, tunnel: 7, device: DEVICE })).toEqual({ success: true, port: 50123 });
    expect(tunnelCalls).toEqual([['open', KEY, MAYA, 7, DEVICE]]);
    tunnelCalls.length = 0;
    for (const device of ['nope', 7, 'DD'.repeat(32), 'dd'.repeat(31)]) {
      expect(await callTunnelRequest({ action: 'open', key: KEY, to: MAYA, tunnel: 7, device })).toMatchObject({ success: false, error: 'Bad tunnel request.' });
    }
    expect(tunnelCalls).toEqual([]);
  });

  it('logs a call event with the check off, and drops a wrong one', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '');
    expect(logCallEvent({ kind: 'connect', s: '0123abcd', peer: 'ff2e6bbf', path: 'tunnel', ms: 812, room: 'channel/secret' })).toBe(true);
    expect(logCallEvent({ kind: 'connect', s: 'nope', peer: 'ff2e6bbf' })).toBe(false);
    expect(diags).toEqual([['call.connect', { s: '0123abcd', peer: 'ff2e6bbf', path: 'tunnel', ms: 812 }]]);
  });

  it("passes members' states and parts to the renderer on circles:call, cleaned, and drops bad ones", () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '');
    listenForCalls();
    handlers.get('call.state')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: { ...STATE, extra: 1 } });
    handlers.get('call.state')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: { ...STATE, s: 'nope' } });
    handlers.get('call.part')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: PART });
    handlers.get('call.part')!({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: { t: 'part' } });
    expect(broadcasts).toEqual([
      ['circles:call', { circleKey: KEY, from: MAYA, device: DEVICE, topic: 'call.state', state: STATE }],
      ['circles:call', { circleKey: KEY, from: MAYA, device: DEVICE, topic: 'call.part', part: PART }],
    ]);
  });

  it('logs tunnel fields and drops wrong ones', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    const logged = logCallCheckResult({
      run: '0123abcd',
      kind: 'connect',
      mode: 'stun+tunnel',
      role: 'caller',
      connected: true,
      path: 'tunnel',
      tunnelMtu: 1200,
      tunnelPackets: 812,
      tunnelSplit: 3,
      tunnelDropped: -1,
    });
    expect(logged).toMatchObject({ mode: 'stun+tunnel', path: 'tunnel', tunnelMtu: 1200, tunnelPackets: 812, tunnelSplit: 3 });
    expect(logged).not.toHaveProperty('tunnelDropped');
    expect(logCallCheckResult({ run: '0123abcd', kind: 'connect', mode: 'tunnel', role: 'caller', connected: false, path: 'x' })).not.toHaveProperty('path');
  });

  it('adds CPU by process kind and the connection context to a result', async () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    const result = { run: '0123abcd', kind: 'long', mode: 'stun', role: 'caller', connected: true, lossInPct: 1.25, checksSent: 9 };
    const logged = await recordCallCheckResult({ key: KEY, to: MAYA, result });
    expect(contextCalls).toEqual([[KEY, MAYA]]);
    expect(logged).toEqual({
      ...result,
      lossInPct: 1.3,
      cpuPercent: 18.8,
      cpuBrowser: 12.3,
      cpuRenderer: 3,
      cpuGpu: 1,
      cpuUtility: 2.5,
      natFirewalled: true,
      natRandomized: false,
      peerConnected: true,
      peerAddr: 'public',
      peerRttMs: 42,
    });
    const { run, ...fields } = logged!;
    expect(diags.at(-1)).toEqual(['call.check', { check: run, ...fields }]);
    // A bad member key skips the context but still logs.
    expect(await recordCallCheckResult({ key: KEY, to: 'nope', result })).not.toHaveProperty('peerAddr');
    expect(contextCalls).toHaveLength(1);
  });

  it('logs a sample with CPU use, and refuses a wrong one or one while the check is off', () => {
    const sample = { run: '0123abcd', stream: 2, kind: 'load', mode: 'tunnel', role: 'answerer', t: 10, path: 'tunnel', switched: false, rttMs: 30, kbpsIn: 900, sdp: 'v=0' };
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '');
    expect(logCallCheckSample(sample)).toBe(false);
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    expect(logCallCheckSample({ ...sample, t: -1 })).toBe(false);
    expect(logCallCheckSample({ ...sample, run: 'xyz' })).toBe(false);
    expect(logCallCheckSample(sample)).toBe(true);
    const [event, data] = diags.at(-1) as [string, Record<string, unknown>];
    expect(event).toBe('call.sample');
    expect(data).toMatchObject({ check: '0123abcd', stream: 2, atS: 10, path: 'tunnel', switched: false, kbpsIn: 900, cpuUtility: 2.5 });
    expect(data).not.toHaveProperty('sdp');
    expect(data).not.toHaveProperty('run');
    expect(data).not.toHaveProperty('t');
  });

  it('sends a part to one member on call.check', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    expect(sendCallCheckSignal(KEY, MAYA, PART)).toBe(true);
    expect(sent).toEqual([[KEY, 'call.check', PART, MAYA]]);
  });

  it('refuses a bad key, member or part', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    expect(sendCallCheckSignal('nope', MAYA, PART)).toBe(false);
    expect(sendCallCheckSignal(KEY, 'nope', PART)).toBe(false);
    expect(sendCallCheckSignal(KEY, MAYA, { ...PART, n: 3 })).toBe(false);
    expect(sendCallCheckSignal(KEY, MAYA, { sdp: 'v=0' })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('passes only well-formed parts to the renderer', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    listenForCallSignals();
    const handler = handlers.get('call.check')!;
    handler({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: PART });
    handler({ circleKey: KEY, fromIdentity: MAYA, fromDevice: DEVICE, payload: { sdp: 'v=0' } });
    expect(broadcasts).toEqual([['circles:call-signal', { circleKey: KEY, from: MAYA, part: PART }]]);
  });

  it('logs known result fields with the app’s CPU, and nothing else', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    const logged = logCallCheckResult({
      run: '0123abcd',
      kind: 'connect',
      mode: 'stun',
      role: 'caller',
      connected: true,
      msToConnect: 412.34,
      localType: 'srflx',
      remoteType: 'host',
      rttMs: 38,
      sdp: 'v=0 c=IN IP4 203.0.113.9',
      address: '203.0.113.9',
      limitedBy: 'gpu',
    });
    expect(logged).toEqual({
      run: '0123abcd',
      kind: 'connect',
      mode: 'stun',
      role: 'caller',
      connected: true,
      msToConnect: 412.3,
      localType: 'srflx',
      remoteType: 'host',
      rttMs: 38,
      cpuPercent: 18.8,
      cpuBrowser: 12.3,
      cpuRenderer: 3,
      cpuGpu: 1,
      cpuUtility: 2.5,
    });
    const { run, ...fields } = logged!;
    expect(diags).toEqual([['call.check', { check: run, ...fields }]]);
  });

  it('logs nothing for a result without a run, mode or role', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    expect(logCallCheckResult({ run: 'xyz', kind: 'connect', mode: 'host', role: 'caller' })).toBeNull();
    expect(logCallCheckResult({ run: '0123abcd', kind: 'connect', mode: 'turn', role: 'caller' })).toBeNull();
    expect(diags).toEqual([]);
  });
});
