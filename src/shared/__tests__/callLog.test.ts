import { describe, expect, it } from 'vitest';
import { cleanCallLog } from '../calls/callLog';

describe('cleanCallLog', () => {
  it('keeps the known fields of a connect, rounded', () => {
    expect(
      cleanCallLog({
        kind: 'connect',
        s: '0123abcd',
        peer: 'ff2e6bbf',
        role: 'offer',
        path: 'tunnel',
        localType: 'host',
        remoteType: 'host',
        ms: 812.345,
        rttMs: 67.89,
        extra: 'dropped',
      })
    ).toEqual({
      ev: 'call.connect',
      fields: { s: '0123abcd', peer: 'ff2e6bbf', role: 'offer', path: 'tunnel', localType: 'host', remoteType: 'host', ms: 812.3, rttMs: 67.9 },
    });
  });

  it('keeps the known fields of an end', () => {
    expect(
      cleanCallLog({ kind: 'end', s: '0123abcd', peer: 'ff2e6bbf', path: 'direct', seconds: 95, pathSwitches: 1, lossInPct: 0.25, kbpsIn: 410.04, kbpsOut: 398, freezes: 2 })
    ).toEqual({
      ev: 'call.end',
      fields: { s: '0123abcd', peer: 'ff2e6bbf', path: 'direct', seconds: 95, pathSwitches: 1, lossInPct: 0.3, kbpsIn: 410, kbpsOut: 398, freezes: 2 },
    });
  });

  it('drops wrong values but keeps the rest', () => {
    expect(cleanCallLog({ kind: 'end', s: '0123abcd', peer: 'ff2e6bbf', path: 'sideways', seconds: -1, lossInPct: Number.NaN, freezes: '3' })).toEqual({
      ev: 'call.end',
      fields: { s: '0123abcd', peer: 'ff2e6bbf' },
    });
  });

  it('refuses an event without a kind, session or peer', () => {
    expect(cleanCallLog({ kind: 'ring', s: '0123abcd', peer: 'ff2e6bbf' })).toBeNull();
    expect(cleanCallLog({ kind: 'end', s: 'not hex!', peer: 'ff2e6bbf' })).toBeNull();
    expect(cleanCallLog({ kind: 'end', s: '0123abcd', peer: 'ff2e6bbf00' })).toBeNull();
    expect(cleanCallLog(null)).toBeNull();
  });
});
