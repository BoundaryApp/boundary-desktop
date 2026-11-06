import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// scripts/freeze-watch.py, run as a developer would with --stdin and --dry-run, so no log stream
// or capture starts. Lines are synthetic tccd attribution lines in `log stream --style ndjson` form.
const SCRIPT = path.resolve(__dirname, '../../../scripts/freeze-watch.py');

function tccdLine(second: string, identifier: string, pid: number): string {
  return JSON.stringify({
    timestamp: `2026-01-01 10:00:${second}.123456-0800`,
    eventMessage: `AUTHREQ_ATTRIBUTION: msgID=1.1, attribution={responsible={TCCDProcess: identifier=com.example.terminal, pid=1}, accessing={TCCDProcess: identifier=${identifier}, pid=${pid}, auid=501, euid=501, binary_path=/Applications/Example.app}}`,
  });
}

function burst(second: string, identifier: string, pid: number, count: number): string[] {
  return Array.from({ length: count }, () => tccdLine(second, identifier, pid));
}

function runWatch(lines: string[], args: string[] = []): { stdout: string; status: number | null } {
  const result = spawnSync('python3', ['-I', SCRIPT, '--stdin', '--dry-run', ...args], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, FREEZE_CAPTURE_DIR: path.join(tmpdir(), 'freeze-watch-test') },
  });
  return { stdout: result.stdout, status: result.status };
}

describe('freeze-watch.py', () => {
  it('reports an Electron process that stays over the threshold for two seconds, once', () => {
    const lines = [
      ...burst('01', 'Electron', 4242, 50),
      ...burst('02', 'Electron', 4242, 55),
      ...burst('03', 'Electron', 4242, 60),
      ...burst('04', 'Electron', 4242, 60),
      tccdLine('05', 'Electron', 4242),
    ];
    const { stdout, status } = runWatch(lines);
    expect(status).toBe(0);
    expect(stdout.match(/flood from Electron pid 4242/g)).toHaveLength(1);
  });

  it('ignores a one-second burst and a busy second that is not followed by another', () => {
    const lines = [
      ...burst('01', 'Electron', 4242, 50),
      ...burst('02', 'Electron', 4242, 5),
      ...burst('03', 'Electron', 4242, 50),
      tccdLine('04', 'Electron', 4242),
    ];
    expect(runWatch(lines).stdout).toBe('');
  });

  it('ignores other apps unless --any is given', () => {
    const lines = [...burst('01', 'com.example.maps', 77, 40), ...burst('02', 'com.example.maps', 77, 40), tccdLine('03', 'x', 1)];
    expect(runWatch(lines).stdout).toBe('');
    expect(runWatch(lines, ['--any']).stdout).toMatch(/flood from com\.example\.maps pid 77/);
  });

  it('skips lines that are not JSON or not attribution lines', () => {
    const lines = ['not json', JSON.stringify({ eventMessage: 'REQUEST: something else' }), ''];
    expect(runWatch(lines)).toEqual({ stdout: '', status: 0 });
  });

  it('counts approval waits per kernel thread, busiest first, with the decimal id sample uses', () => {
    const code = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location('fw', ${JSON.stringify(SCRIPT)})`,
      'fw = importlib.util.module_from_spec(spec); spec.loader.exec_module(fw)',
      'lines = ["2026-01-01 10:00:01.1 Df kernel[0:15422] (Sandbox) approval_response_wait: sleep interrupted"] * 3',
      'lines += ["2026-01-01 10:00:01.2 Df kernel[0:2f3daf] (Sandbox) approval_response_wait: sleep interrupted", "unrelated"]',
      'print(json.dumps(fw.kernel_thread_counts(lines)))',
    ].join('\n');
    const result = spawnSync('python3', ['-I', '-B', '-c', code], { encoding: 'utf8' });
    expect(JSON.parse(result.stdout)).toEqual([
      ['15422', 87074, 3],
      ['2f3daf', 3095983, 1],
    ]);
  });
});
