import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureFrames, classifyPath, createSyncFsRecorder, stackFrames, wrapSyncFs } from '../perf/syncFsProbe';

let clock = 0;
let lines: Record<string, unknown>[] = [];
const frames = vi.fn(() => ['readStore@index.js:10', 'listThreads@index.js:20']);

function recorder(write: (line: string) => void = (line) => lines.push(JSON.parse(line))) {
  return createSyncFsRecorder({ now: () => clock, write, frames, pathClass: (target) => String(target) });
}

beforeEach(() => {
  clock = 0;
  lines = [];
  frames.mockClear();
});

describe('createSyncFsRecorder', () => {
  it('stays silent and takes no stacks for a few quick calls', () => {
    const r = recorder();
    for (let i = 0; i < 5; i++) r.record('readFileSync', 'app', 1);
    r.flush();
    expect(lines).toEqual([]);
    expect(frames).not.toHaveBeenCalled();
  });

  it('logs a slow call at once, with its caller', () => {
    recorder().record('openSync', 'documents', 25.4);
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'sync-fs-slow',
        op: 'openSync',
        pathClass: 'documents',
        ms: 25,
        frames: ['readStore@index.js:10', 'listThreads@index.js:20'],
      }),
    ]);
  });

  it('logs a burst during the blocked loop, on the first call after its window ends', () => {
    const r = recorder();
    for (let i = 0; i < 60; i++) {
      r.record('readFileSync', 'documents', 2);
      clock += 16;
    }
    expect(lines).toHaveLength(0);
    clock = 1_000;
    r.record('readFileSync', 'documents', 2);
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'sync-fs-burst',
        calls: 60,
        totalMs: 120,
        classes: { documents: 60 },
        top: [expect.objectContaining({ op: 'readFileSync', calls: 51, ms: 102 })],
      }),
    ]);
  });

  it('counts separate callers apart, most frequent first', () => {
    const r = recorder();
    for (let i = 0; i < 70; i++) {
      frames.mockReturnValueOnce([i % 3 === 0 ? 'rare@a.js:1' : 'common@a.js:2']);
      r.record('openSync', 'home', 1);
    }
    r.flush();
    const top = lines[0].top as { frames: string[] }[];
    expect(top.map((caller) => caller.frames)).toEqual([['common@a.js:2'], ['rare@a.js:1']]);
  });

  it('caps the slow lines in a window', () => {
    const r = recorder();
    for (let i = 0; i < 30; i++) r.record('openSync', 'home', 30);
    expect(lines.filter((line) => line.kind === 'sync-fs-slow')).toHaveLength(10);
  });

  it('stops writing past its size cap', () => {
    const r = recorder();
    frames.mockReturnValue(['x'.repeat(1024 * 1024)]);
    for (let i = 0; i < 20; i++) {
      r.record('openSync', 'home', 30);
      clock += 2_000;
    }
    expect(lines.length).toBeLessThanOrEqual(6);
    frames.mockReset();
  });

  it('ignores the file calls its own write makes', () => {
    const r: ReturnType<typeof recorder> = recorder((line) => {
      lines.push(JSON.parse(line));
      r.record('writeFileSync', 'logs', 30);
    });
    for (let i = 0; i < 60; i++) r.record('readFileSync', 'documents', 1);
    clock = 1_000;
    r.flush();
    expect(lines.map((line) => line.kind)).toEqual(['sync-fs-burst']);
  });

  it('survives a failed write', () => {
    const r = recorder(() => {
      throw new Error('disk full');
    });
    expect(() => r.record('openSync', 'home', 30)).not.toThrow();
  });
});

describe('wrapSyncFs', () => {
  const quiet = { record: vi.fn(), flush: vi.fn() };
  beforeEach(() => quiet.record.mockClear());

  it('passes arguments and results through, and records the time taken', () => {
    const target = {
      readFileSync: (file: string) => {
        clock += 7;
        return `read ${file}`;
      },
    };
    wrapSyncFs(target, quiet, () => clock);
    expect(target.readFileSync('/a')).toBe('read /a');
    expect(quiet.record).toHaveBeenCalledWith('readFileSync', '/a', 7);
  });

  it('records a call that throws, and still throws', () => {
    const target = {
      openSync: () => {
        throw new Error('ENOENT');
      },
    };
    wrapSyncFs(target, quiet, () => clock);
    expect(() => target.openSync()).toThrow('ENOENT');
    expect(quiet.record).toHaveBeenCalledTimes(1);
  });

  it('counts a call made inside another once', () => {
    const target = {
      openSync: () => 3,
      readFileSync(): number {
        return target.openSync();
      },
    };
    wrapSyncFs(target, quiet, () => clock);
    target.readFileSync();
    expect(quiet.record).toHaveBeenCalledTimes(1);
    expect(quiet.record).toHaveBeenCalledWith('readFileSync', undefined, 0);
  });

  it('leaves calls it does not watch alone', () => {
    const statSync = () => 1;
    const target = { statSync };
    wrapSyncFs(target, quiet, () => clock);
    expect(target.statSync).toBe(statSync);
  });
});

describe('stackFrames', () => {
  it('keeps function, file name and line, and drops directories and Node', () => {
    const stack = [
      'Error',
      '    at Object.readFileSync (node:fs:441:20)',
      '    at #readStore (/Users/someone/app/.vite/build/index.js:15934:3)',
      '    at /Users/someone/app/.vite/build/index.js:20:5',
    ].join('\n');
    expect(stackFrames(stack)).toEqual(['#readStore@index.js:15934', '(anonymous)@index.js:20']);
  });

  it('skips frames from the top', () => {
    const stack = 'Error\n    at probe (/a/index.js:1:1)\n    at caller (/a/index.js:2:1)';
    expect(stackFrames(stack, 1)).toEqual(['caller@index.js:2']);
  });

  it('starts at the code that made the call, past the probe’s own frames', () => {
    const target = {
      readFileSync: () => {
        clock += 30;
      },
    };
    const r = createSyncFsRecorder({
      now: () => clock,
      write: (line) => lines.push(JSON.parse(line)),
      frames: captureFrames,
      pathClass: () => 'home',
    });
    wrapSyncFs(target, r, () => clock);
    function readTheStore() {
      target.readFileSync();
    }
    readTheStore();
    expect((lines[0].frames as string[])[0]).toMatch(/^readTheStore@/);
  });

  it('handles a missing stack', () => {
    expect(stackFrames(undefined)).toEqual([]);
  });
});

describe('classifyPath', () => {
  const home = path.join(path.sep, 'Users', 'me');
  const roots = {
    app: path.join(home, 'Documents', 'Work', 'app'),
    appData: path.join(home, 'Library', 'Application Support'),
    logs: path.join(home, 'Library', 'Logs', 'App'),
    documents: path.join(home, 'Documents'),
    home,
  };

  it.each([
    [path.join(roots.app, 'node_modules', 'x', 'index.js'), 'app-modules'],
    [path.join(roots.app, '.vite', 'build', 'index.js'), 'app'],
    [path.join(roots.appData, 'App', 'store.json'), 'app-data'],
    [path.join(roots.logs, 'debug.log'), 'logs'],
    [path.join(home, 'Documents', 'Work', 'sibling', 'data', 'x'), 'app-sibling'],
    [path.join(home, 'Documents', 'other.txt'), 'documents'],
    [path.join(home, 'notes.txt'), 'home'],
    ['/etc/hosts', 'other'],
  ])('%s is %s', (file, expected) => {
    expect(classifyPath(file, roots)).toBe(expected);
  });

  it('reads file descriptors and URLs, and a similar prefix is not a match', () => {
    expect(classifyPath(7, roots)).toBe('fd');
    expect(classifyPath(new URL(`file://${roots.app}/a.js`), roots)).toBe('app');
    expect(classifyPath(`${roots.app}-old/a.js`, roots)).toBe('app-sibling');
  });
});
