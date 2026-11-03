import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as unknown[][]);
const handlers = vi.hoisted(() => new Map<string, (signal: { circleKey: string; fromIdentity: string; payload: unknown }) => void>());
const broadcasts = vi.hoisted(() => [] as unknown[][]);
const diags = vi.hoisted(() => [] as unknown[][]);
vi.mock('../circlesService', () => ({
  sendCircleSignal: (...args: unknown[]) => {
    sent.push(args);
    return true;
  },
  onCircleSignal: (topic: string, handler: (signal: { circleKey: string; fromIdentity: string; payload: unknown }) => void) => {
    handlers.set(topic, handler);
    return () => handlers.delete(topic);
  },
}));
vi.mock('../../windows', () => ({ broadcast: (...args: unknown[]) => broadcasts.push(args) }));
vi.mock('../circlesDiagnostics', () => ({ diag: (...args: unknown[]) => diags.push(args) }));
vi.mock('electron', () => ({
  app: { getAppMetrics: () => [{ cpu: { percentCPUUsage: 12.34 } }, { cpu: { percentCPUUsage: 3 } }] },
}));

import { callCheckEnabled, listenForCallSignals, logCallCheckResult, sendCallCheckSignal } from '../callSignals';

const KEY = 'cc'.repeat(32);
const MAYA = 'bb'.repeat(32);
const PART = { t: 'part', id: '0123456789abcdef', n: 0, of: 1, z: 'eA==' };

describe('call signals', () => {
  beforeEach(() => {
    sent.length = 0;
    broadcasts.length = 0;
    diags.length = 0;
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
    handler({ circleKey: KEY, fromIdentity: MAYA, payload: PART });
    handler({ circleKey: KEY, fromIdentity: MAYA, payload: { sdp: 'v=0' } });
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
      cpuPercent: 15.3,
    });
    expect(diags).toEqual([['call.check', logged]]);
  });

  it('logs nothing for a result without a run, mode or role', () => {
    vi.stubEnv('BOUNDARY_CALLS_CHECK', '1');
    expect(logCallCheckResult({ run: 'xyz', kind: 'connect', mode: 'host', role: 'caller' })).toBeNull();
    expect(logCallCheckResult({ run: '0123abcd', kind: 'connect', mode: 'turn', role: 'caller' })).toBeNull();
    expect(diags).toEqual([]);
  });
});
