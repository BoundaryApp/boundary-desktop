import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyProtected,
  createProtectedFsRecorder,
  fsTargets,
  rotateIfLarge,
  spawnTargets,
  wrapCalls,
  type Nesting,
} from '../perf/protectedFsProbe';
import { captureFrames } from '../perf/syncFsProbe';

const roots = {
  app: '/Users/u/Documents/Work/boundary',
  documents: '/Users/u/Documents',
  desktop: '/Users/u/Desktop',
  downloads: '/Users/u/Downloads',
  home: '/Users/u',
};

describe('classifyProtected', () => {
  it('ignores paths macOS does not guard', () => {
    expect(classifyProtected('/Users/u/Library/Logs/Boundary/x.log', roots)).toBeNull();
    expect(classifyProtected('/tmp/x', roots)).toBeNull();
    expect(classifyProtected(12, roots)).toBeNull();
    expect(classifyProtected(undefined, roots)).toBeNull();
  });

  it('names the checkout, its siblings and other guarded folders, two folders deep and never the file', () => {
    expect(classifyProtected('/Users/u/Documents/Work/boundary/node_modules/a/b/c.js', roots)).toEqual({
      pathClass: 'app-modules',
      area: 'a/b',
    });
    expect(classifyProtected('/Users/u/Documents/Work/boundary/.vite/build/main.js', roots)).toEqual({
      pathClass: 'app',
      area: '.vite/build',
    });
    expect(classifyProtected('/Users/u/Documents/Work/assistant/data/hermes/sessions/chat-id.json', roots)).toEqual({
      pathClass: 'app-sibling',
      area: 'assistant/data',
    });
    expect(classifyProtected('/Users/u/Documents/Work/boundary', roots)).toEqual({ pathClass: 'app', area: '' });
    expect(classifyProtected('/Users/u/Documents/notes.txt', roots)).toEqual({ pathClass: 'documents', area: '' });
    expect(classifyProtected('/Users/u/Downloads/x.zip', roots)).toEqual({ pathClass: 'downloads', area: '' });
    expect(classifyProtected('/Users/u/Library/Mobile Documents/com~apple~CloudDocs/a/b/c', roots)).toEqual({
      pathClass: 'icloud',
      area: 'com~apple~CloudDocs/a',
    });
  });

  it('reads URLs and Buffers, and resolves relative paths against the working folder', () => {
    expect(classifyProtected(new URL('file:///Users/u/Desktop/a/b.txt'), roots)?.pathClass).toBe('desktop');
    expect(classifyProtected(Buffer.from('/Users/u/Desktop/b.txt'), roots)?.pathClass).toBe('desktop');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/Users/u/Documents/Work/boundary');
    expect(classifyProtected('package.json', roots)?.pathClass).toBe('app');
    cwd.mockRestore();
  });
});

let clock = 0;
let lines: Record<string, unknown>[] = [];
const frames = vi.fn(() => ['readThreads@index.js:10']);

function recorder(write: (line: string) => void = (line) => lines.push(JSON.parse(line))) {
  return createProtectedFsRecorder({
    now: () => clock,
    write,
    frames,
    classify: (target) => (typeof target === 'string' && target.startsWith('doc') ? { pathClass: 'documents', area: target } : null),
  });
}

beforeEach(() => {
  clock = 0;
  lines = [];
  frames.mockClear();
});

describe('createProtectedFsRecorder', () => {
  it('records nothing and takes no stacks for unguarded paths', () => {
    const r = recorder();
    r.record('stat', ['/tmp/a', undefined]);
    r.flushWindow();
    r.flushSummary();
    expect(lines).toEqual([]);
    expect(frames).not.toHaveBeenCalled();
  });

  it('records the first guarded target of a call', () => {
    const r = recorder();
    r.record('rename', ['/tmp/a', 'doc-b']);
    r.flushSummary();
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'protected-fs-summary',
        calls: 1,
        top: [{ op: 'rename', pathClass: 'documents', area: 'doc-b', frames: ['readThreads@index.js:10'], calls: 1 }],
      }),
    ]);
  });

  it('logs a burst of guarded calls on the first call after its second ends', () => {
    const r = recorder();
    for (let i = 0; i < 25; i++) {
      r.record('promises.stat', ['doc']);
      clock += 30;
    }
    expect(lines).toEqual([]);
    clock = 1_000;
    r.record('promises.stat', ['doc']);
    expect(lines).toEqual([
      expect.objectContaining({
        kind: 'protected-fs-burst',
        calls: 25,
        top: [expect.objectContaining({ op: 'promises.stat', calls: 25 })],
      }),
    ]);
  });

  it('does not log a second with fewer calls than a burst', () => {
    const r = recorder();
    for (let i = 0; i < 19; i++) r.record('stat', ['doc']);
    r.flushWindow();
    expect(lines).toEqual([]);
  });

  it('stops taking stacks after the first 500 calls of a minute, and counts the rest', () => {
    const r = recorder();
    for (let i = 0; i < 600; i++) r.record('stat', ['doc']);
    expect(frames).toHaveBeenCalledTimes(500);
    r.flushSummary();
    expect(lines.at(-1)).toEqual(
      expect.objectContaining({ kind: 'protected-fs-summary', calls: 600, unsampled: 100 })
    );
    r.record('stat', ['doc']);
    expect(frames).toHaveBeenCalledTimes(501);
  });

  it('ignores calls made while writing its own line, and survives a failing write', () => {
    const holder: { r?: ReturnType<typeof recorder> } = {};
    const write = vi.fn(() => {
      holder.r?.record('appendFileSync', ['doc']);
      throw new Error('disk full');
    });
    const r = recorder(write);
    holder.r = r;
    r.record('stat', ['doc']);
    expect(() => r.flushSummary()).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    r.flushSummary();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('protected-fs trace', () => {
  function traced() {
    const traceLines: Record<string, unknown>[] = [];
    const r = createProtectedFsRecorder({
      now: () => clock,
      write: (line) => lines.push(JSON.parse(line)),
      trace: (line) => traceLines.push(JSON.parse(line)),
      frames,
      classify: (target) =>
        typeof target === 'string' && target.startsWith('doc') ? { pathClass: 'documents', area: target } : null,
    });
    return { r, traceLines };
  }

  it('writes a line for each guarded call when it is recorded, before the call runs', () => {
    const { r, traceLines } = traced();
    r.record('existsSync', ['doc-a']);
    r.record('stat', ['/tmp/a']);
    expect(traceLines).toEqual([
      expect.objectContaining({
        kind: 'protected-fs-call',
        op: 'existsSync',
        pathClass: 'documents',
        area: 'doc-a',
        frames: ['readThreads@index.js:10'],
      }),
    ]);
    expect(lines).toEqual([]);
  });

  it('keeps writing call lines, without stacks, once a minute stops taking them', () => {
    const { r, traceLines } = traced();
    for (let i = 0; i < 501; i++) r.record('stat', ['doc']);
    expect(traceLines).toHaveLength(501);
    expect(traceLines.at(-1)).not.toHaveProperty('frames');
    expect(traceLines.at(-2)).toHaveProperty('frames');
  });

  it('writes main-alive lines to the trace only', () => {
    const { r, traceLines } = traced();
    r.alive();
    expect(traceLines).toEqual([expect.objectContaining({ kind: 'main-alive' })]);
    expect(lines).toEqual([]);
  });

  it('ignores calls made while writing a trace line', () => {
    const traceLines: string[] = [];
    const holder: { r?: ReturnType<typeof createProtectedFsRecorder> } = {};
    const r = createProtectedFsRecorder({
      now: () => 0,
      write: () => undefined,
      trace: (line) => {
        traceLines.push(line);
        holder.r?.record('appendFileSync', ['doc']);
      },
      frames,
      classify: () => ({ pathClass: 'documents', area: '' }),
    });
    holder.r = r;
    r.record('stat', ['doc']);
    expect(traceLines).toHaveLength(1);
  });
});

describe('rotateIfLarge', () => {
  it('moves a large trace aside, replacing the older one, and leaves a small one', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-fs-trace-'));
    const file = path.join(dir, 'protected-fs-trace.jsonl');
    fs.writeFileSync(path.join(dir, 'protected-fs-trace.1.jsonl'), 'old');
    fs.writeFileSync(file, 'x'.repeat(20));
    rotateIfLarge(file, 100);
    expect(fs.existsSync(file)).toBe(true);
    rotateIfLarge(file, 10);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'protected-fs-trace.1.jsonl'), 'utf8')).toBe('x'.repeat(20));
    rotateIfLarge(path.join(dir, 'missing.jsonl'), 10);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('wrapCalls', () => {
  it('reports each call before running it, and returns its result', () => {
    const calls: string[] = [];
    const target = { stat: (p: string) => `stat ${p}` };
    wrapCalls(target, ['stat', 'missing'], (op, args) => calls.push(`${op} ${args[0]}`), { depth: 0 }, 'promises.');
    expect(target.stat('a')).toBe('stat a');
    expect(calls).toEqual(['promises.stat a']);
  });

  it('reports a call made inside another wrapped call once', () => {
    const calls: string[] = [];
    const target: Record<string, (...args: unknown[]) => unknown> = {
      spawn: () => 'child',
      exec: (cmd) => target.spawn('/bin/sh', ['-c', cmd]),
    };
    wrapCalls(target, ['spawn', 'exec'], (op) => calls.push(op), { depth: 0 });
    expect(target.exec('ls')).toBe('child');
    expect(calls).toEqual(['exec']);
    target.spawn('ls');
    expect(calls).toEqual(['exec', 'spawn']);
  });

  it('runs the call when reporting throws, and keeps nesting balanced when the call throws', () => {
    const nesting: Nesting = { depth: 0 };
    const target = {
      ok: () => 1,
      bad: () => {
        throw new Error('ENOENT');
      },
    };
    wrapCalls(target, ['ok', 'bad'], () => {
      throw new Error('probe bug');
    }, nesting);
    expect(target.ok()).toBe(1);
    expect(() => target.bad()).toThrow('ENOENT');
    expect(nesting.depth).toBe(0);
  });

  it("wraps Node's own execFile, whose promisify.custom can't be redefined", async () => {
    const childProcess = await import('node:child_process');
    const target = { execFile: childProcess.execFile };
    const calls: string[] = [];
    wrapCalls(target, ['execFile'], (op) => calls.push(op), { depth: 0 });
    const result = await promisify(target.execFile)(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(result).toEqual({ stdout: 'hi', stderr: '' });
    expect(calls).toEqual(['execFile']);
  });

  it('keeps properties such as realpath.native and reports through promisify.custom', async () => {
    const calls: string[] = [];
    const native = () => 'native';
    const execFile = Object.assign(() => undefined, {
      native,
      [promisify.custom]: async (file: string) => ({ stdout: `ran ${file}`, stderr: '' }),
    });
    const target = { execFile };
    wrapCalls(target, ['execFile'], (op, args) => calls.push(`${op} ${args[0]}`), { depth: 0 });
    expect((target.execFile as unknown as { native: unknown }).native).toBe(native);
    await expect(promisify(target.execFile)('git')).resolves.toEqual({ stdout: 'ran git', stderr: '' });
    expect(calls).toEqual(['execFile git']);
  });

  it("puts the calling function first in the recorded stack", () => {
    const r = createProtectedFsRecorder({
      now: () => 0,
      write: (line) => lines.push(JSON.parse(line)),
      frames: () => captureFrames(5),
      classify: () => ({ pathClass: 'documents', area: '' }),
    });
    const target = { stat: () => undefined };
    wrapCalls(target, ['stat'], (op, args) => r.record(op, fsTargets(op, args)), { depth: 0 });
    function callerUnderTest() {
      target.stat('/Users/u/Documents/a');
    }
    callerUnderTest();
    r.flushSummary();
    const top = (lines[0].top as { frames: string[] }[])[0];
    expect(top.frames[0]).toMatch(/^callerUnderTest@/);
  });
});

describe('spawnTargets', () => {
  const cwd = () => '/Users/u/Documents/Work/boundary';

  it('uses the inherited working folder when none is given, and the program for spawn', () => {
    expect(spawnTargets('spawn', ['docker', ['ps']], cwd)).toEqual([cwd(), 'docker']);
    expect(spawnTargets('execFile', ['git', ['status'], () => undefined], cwd)).toEqual([cwd(), 'git']);
  });

  it('uses the given working folder, and only the folder for a shell command', () => {
    expect(spawnTargets('spawn', ['docker', ['ps'], { cwd: '/tmp' }], cwd)).toEqual(['/tmp', 'docker']);
    expect(spawnTargets('exec', ['ls -la', { cwd: '/tmp' }], cwd)).toEqual(['/tmp']);
    expect(spawnTargets('execSync', ['ls -la'], cwd)).toEqual([cwd()]);
  });
});

describe('fsTargets', () => {
  it('takes both paths of rename and copy', () => {
    expect(fsTargets('rename', ['/a', '/b', () => undefined])).toEqual(['/a', '/b']);
    expect(fsTargets('promises.copyFile', ['/a', '/b'])).toEqual(['/a', '/b']);
    expect(fsTargets('renameSync', ['/a', '/b'])).toEqual(['/a', '/b']);
  });

  it("doesn't treat an encoding or options as a path", () => {
    expect(fsTargets('readFileSync', ['/a', 'utf8'])).toEqual(['/a']);
    expect(fsTargets('promises.writeFile', ['/a', 'data', 'utf8'])).toEqual(['/a']);
  });

  it("keeps an electron-store read out of the log when the working folder is the checkout", () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/Users/u/Documents/Work/boundary');
    const targets = fsTargets('readFileSync', ['/Users/u/Library/Application Support/Boundary/config.json', 'utf8']);
    expect(targets.map((target) => classifyProtected(target, roots))).toEqual([null]);
    cwd.mockRestore();
  });
});
