import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {} }));
vi.mock('../circlesDiagnostics', () => ({ circlesDiagnosticsPath: () => '/nowhere', diagnosticsRunId: () => 'run-1' }));

import { buildCallCheckReport, cleanLabel, eventsForRun, reportFileName, REPORT_FORMAT } from '../callCheckReport';

const ENV = {
  app: 'Boundary',
  appVersion: '0.4.0',
  electron: '45.0.0',
  chrome: '140',
  os: '26.1',
  osRelease: '25.6.0',
  arch: 'arm64',
  model: 'Mac15,6',
  cpu: 'Apple M3 Pro',
  cores: 12,
  memGb: 36,
};

// What main adds to a result when it logs one; an export must keep it.
const CONTEXT_ROW_WITHOUT_ADDR = {
  run: '4567cdef',
  kind: 'long',
  mode: 'stun',
  role: 'answerer',
  connected: true,
  cpuPercent: 18.8,
  cpuBrowser: 12.3,
  cpuRenderer: 3,
  cpuGpu: 1,
  cpuUtility: 2.5,
  natFirewalled: true,
  natRandomized: false,
  peerConnected: true,
  peerRttMs: 42,
  peerRetransmits: 7,
  peerAgeS: 177,
  peerMtu: 1424,
};
const CONTEXT_ROW = { ...CONTEXT_ROW_WITHOUT_ADDR, peerAddr: 'public' };

describe('call check report', () => {
  it('keeps one line of printable text, at most 60 characters', () => {
    expect(cleanLabel('  home\tWi-Fi\n‮upstairs ')).toBe('home Wi-Fi upstairs');
    expect(cleanLabel('x'.repeat(80))).toHaveLength(60);
    expect(cleanLabel(42)).toBe('');
  });

  it('takes only this launch’s events, from both files in order, and skips cut-off lines', () => {
    const older = [JSON.stringify({ run: 'run-0', ev: 'net.heartbeat' }), JSON.stringify({ run: 'run-1', ev: 'run.start' })].join('\n');
    const current = [
      JSON.stringify({ run: 'run-1', ev: 'call.check', mode: 'tunnel' }),
      '{"run":"run-1","ev":"call.sam',
      JSON.stringify({ run: 'run-10', ev: 'other launch' }),
      '',
    ].join('\n');
    expect(eventsForRun([older, current], 'run-1')).toEqual([
      { run: 'run-1', ev: 'run.start' },
      { run: 'run-1', ev: 'call.check', mode: 'tunnel' },
    ]);
  });

  it('builds a report of cleaned results, the environment and the events', () => {
    const report = buildCallCheckReport({
      label: 'phone hotspot',
      results: [
        { run: '0123abcd', kind: 'connect', mode: 'tunnel', role: 'caller', connected: true, path: 'tunnel', note: 'dropped' },
        { run: 'nope' },
        CONTEXT_ROW,
        { ...CONTEXT_ROW, peerAddr: 'somewhere' },
      ],
      environment: ENV,
      diagnostics: [JSON.stringify({ run: 'run-1', ev: 'dht.nat-update' })],
      run: 'run-1',
      now: new Date('2026-11-06T15:30:00Z'),
    });
    expect(report).toEqual({
      format: REPORT_FORMAT,
      exportedAt: '2026-11-06T15:30:00.000Z',
      label: 'phone hotspot',
      diagnosticsRun: 'run-1',
      environment: ENV,
      results: [
        { run: '0123abcd', kind: 'connect', mode: 'tunnel', role: 'caller', connected: true, path: 'tunnel' },
        CONTEXT_ROW,
        CONTEXT_ROW_WITHOUT_ADDR,
      ],
      events: [{ run: 'run-1', ev: 'dht.nat-update' }],
    });
    expect(buildCallCheckReport({ label: '', results: 'x', environment: ENV, diagnostics: [], run: 'run-1' }).results).toEqual([]);
  });

  it('names the file after the label and the local time', () => {
    const at = new Date(2026, 10, 6, 15, 7);
    expect(reportFileName('Home Wi-Fi (upstairs)', at)).toBe('call-check-home-wi-fi-upstairs-20261106-1507.json');
    expect(reportFileName('', at)).toBe('call-check-mac-20261106-1507.json');
    expect(reportFileName('Café ¿?', at)).toBe('call-check-caf-20261106-1507.json');
    expect(reportFileName(`${'a'.repeat(39)} b`, at)).toBe(`call-check-${'a'.repeat(39)}-20261106-1507.json`);
  });
});
