import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressClass } from '../addressClass';

const logDir = vi.hoisted(() => ({ current: '' }));

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9-rc.1', isPackaged: true } }));
// Test files that reach `diag` for real append to the shared test log from other workers.
vi.mock('../../../persistDebugLog', () => ({
  getDebugLogPath: () => path.join(logDir.current, 'boundary-debug.log'),
}));

async function load() {
  vi.resetModules();
  return import('../circlesDiagnostics');
}

function lines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('circlesDiagnostics', () => {
  beforeEach(() => {
    logDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'circles-diagnostics-'));
  });

  afterEach(() => {
    fs.rmSync(logDir.current, { recursive: true, force: true });
  });

  it('starts each run with a header, then writes one JSON object per event', async () => {
    const { diag, circlesDiagnosticsPath } = await load();
    diag('peer.connect', { device: 'abcd1234' });
    diag('net.heartbeat', { lagMs: 3 }, 'net', Date.UTC(2026, 9, 29, 12, 0, 0));
    const [header, first, second] = lines(circlesDiagnosticsPath());
    expect(header).toMatchObject({ ev: 'run.start', appVersion: '9.9.9-rc.1', packaged: true, platform: process.platform });
    expect(first).toMatchObject({ src: 'main', ev: 'peer.connect', device: 'abcd1234', run: expect.any(String) });
    expect(second).toMatchObject({ src: 'net', ev: 'net.heartbeat', t: '2026-10-29T12:00:00.000Z', lagMs: 3 });
    expect(first.run).toBe(second.run);
  });

  it('keeps going when the file can’t be written', async () => {
    const { diag } = await load();
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => diag('x')).not.toThrow();
    expect(() => diag('y')).not.toThrow();
    append.mockRestore();
  });

  it('shortens keys to 8 characters', async () => {
    const { short } = await load();
    expect(short('ab'.repeat(32))).toBe('abababab');
    expect(short(null)).toBeNull();
  });
});

describe('addressClass', () => {
  it('names the kind of address, never the address', () => {
    expect(
      ['127.0.0.1', '192.168.1.20', '10.0.0.2', '172.20.0.1', '100.72.1.1', '169.254.3.4', '8.8.8.8', '::1', 'fe80::1', '', 'x.y']
        .map(addressClass)
    ).toEqual(['loopback', 'lan', 'lan', 'lan', 'cgnat', 'link-local', 'public', 'loopback', 'ipv6', 'none', 'unknown']);
  });
});
