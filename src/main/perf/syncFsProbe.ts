/**
 * Lag probe (see src/shared/lagProbe.ts): names the code behind synchronous file calls on
 * the main thread. A burst of them blocks every window, and the log's write stream can't
 * flush until the thread is free, so this appends directly to sync-fs.jsonl, a line at a
 * time, and those lines survive a force quit.
 *
 * Records the operation, a class of path, durations and function names. Never a file name
 * or file contents: paths can hold chat ids, and the classes are enough to place a burst.
 */
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/** One call this long is logged by itself. */
const SLOW_CALL_MS = 20;
const WINDOW_MS = 1_000;
/** A window with this many calls is logged. */
const BURST_CALLS = 50;
/** Stacks are too costly for every call, so a window starts taking them here. */
const SAMPLE_FROM_CALL = 10;
const TOP_CALLERS = 8;
const STACK_FRAMES = 12;
/** captureFrames, record and the wrapper, always on top of a stack. The bundle hides their file. */
const PROBE_FRAMES = 3;
const MAX_SLOW_LINES_PER_WINDOW = 10;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const WRAPPED = [
  'openSync',
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'readdirSync',
  'opendirSync',
  'copyFileSync',
] as const;

interface RecorderDeps {
  now: () => number;
  write: (line: string) => void;
  /** Function names, innermost first. Only called when a call or window needs them. */
  frames: () => string[];
  pathClass: (target: unknown) => string;
}

export interface SyncFsRecorder {
  record(op: string, target: unknown, ms: number): void;
  /** Ends the current window, logging it if it was a burst. */
  flush(): void;
}

export function createSyncFsRecorder({ now, write, frames, pathClass }: RecorderDeps): SyncFsRecorder {
  let windowStart = now();
  let calls = 0;
  let totalMs = 0;
  let slowLines = 0;
  let classes: Record<string, number> = {};
  let callers = new Map<string, { op: string; pathClass: string; frames: string[]; calls: number; ms: number }>();
  let written = 0;
  /** Node's append goes through its other file calls, which are wrapped. */
  let logging = false;

  const log = (entry: Record<string, unknown>) => {
    if (written > MAX_LOG_BYTES) return;
    const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + '\n';
    written += line.length;
    logging = true;
    try {
      write(line);
    } catch {
      /* A probe must not break the file call it watches. */
    } finally {
      logging = false;
    }
  };

  const flush = () => {
    if (calls >= BURST_CALLS) {
      const top = [...callers.values()].sort((a, b) => b.calls - a.calls).slice(0, TOP_CALLERS);
      log({ kind: 'sync-fs-burst', windowMs: Math.round(now() - windowStart), calls, totalMs: Math.round(totalMs), classes, top });
    }
    windowStart = now();
    calls = 0;
    totalMs = 0;
    slowLines = 0;
    classes = {};
    callers = new Map();
  };

  const record = (op: string, target: unknown, ms: number) => {
    if (logging) return;
    if (now() - windowStart >= WINDOW_MS) flush();
    const cls = pathClass(target);
    calls++;
    totalMs += ms;
    classes[cls] = (classes[cls] ?? 0) + 1;
    const slow = ms >= SLOW_CALL_MS;
    if (!slow && calls < SAMPLE_FROM_CALL) return;
    const stack = frames();
    if (slow && slowLines < MAX_SLOW_LINES_PER_WINDOW) {
      slowLines++;
      log({ kind: 'sync-fs-slow', op, pathClass: cls, ms: Math.round(ms), frames: stack });
    }
    const key = `${op}|${cls}|${stack.join('<')}`;
    const caller = callers.get(key);
    if (caller) {
      caller.calls++;
      caller.ms += ms;
    } else {
      callers.set(key, { op, pathClass: cls, frames: stack, calls: 1, ms });
    }
  };

  return { record, flush };
}

/** `fn@file:line` for a V8 stack line, or null for Node's own. */
function frameOf(line: string): string | null {
  const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line);
  if (!match) return null;
  const [, fn, file, lineNumber] = match;
  if (file.startsWith('node:')) return null;
  return `${fn ?? '(anonymous)'}@${path.basename(file)}:${lineNumber}`;
}

export function stackFrames(stack: string | undefined, skip = 0): string[] {
  const frames = (stack ?? '').split('\n').slice(1 + skip).map(frameOf);
  return frames.filter((frame): frame is string => frame !== null).slice(0, STACK_FRAMES);
}

export function captureFrames(): string[] {
  const limit = Error.stackTraceLimit;
  // Enough to reach past a store library's own frames to the code that called it.
  Error.stackTraceLimit = STACK_FRAMES + PROBE_FRAMES + 12;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  return stackFrames(stack, PROBE_FRAMES);
}

interface PathRoots {
  app: string;
  appData: string;
  logs: string;
  documents: string;
  home: string;
}

/** Which kind of place a file call touched. First match wins, so go from specific to general. */
export function classifyPath(target: unknown, roots: PathRoots): string {
  if (typeof target === 'number') return 'fd';
  const file = target instanceof URL ? target.pathname : String(target);
  const within = (root: string) => file === root || file.startsWith(root + path.sep);
  if (within(path.join(roots.app, 'node_modules'))) return 'app-modules';
  if (within(roots.app)) return 'app';
  if (within(roots.appData)) return 'app-data';
  if (within(roots.logs)) return 'logs';
  if (within(path.dirname(roots.app))) return 'app-sibling';
  if (within(roots.documents)) return 'documents';
  if (within(roots.home)) return 'home';
  return 'other';
}

type SyncFn = (...args: unknown[]) => unknown;

/** Replaces the sync calls on `target` with timed ones. Calls made inside another count once. */
export function wrapSyncFs(target: object, recorder: SyncFsRecorder, now: () => number): void {
  const methods = target as Record<string, SyncFn>;
  let depth = 0;
  for (const op of WRAPPED) {
    const original = methods[op];
    if (typeof original !== 'function') continue;
    methods[op] = function (this: unknown, ...args: unknown[]) {
      const start = now();
      depth++;
      try {
        return original.apply(this, args);
      } finally {
        depth--;
        if (depth === 0) recorder.record(op, args[0], now() - start);
      }
    };
  }
}

/** Starts recording this process's synchronous file calls to `logFile`. */
export function installSyncFsProbe(logFile: string, roots: PathRoots): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // The originals, so the probe's own writes aren't recorded.
  const { appendFileSync } = fs;
  const now = () => performance.now();
  const recorder = createSyncFsRecorder({
    now,
    write: (line) => appendFileSync(logFile, line, 'utf8'),
    frames: captureFrames,
    pathClass: (target) => classifyPath(target, roots),
  });
  wrapSyncFs(fs, recorder, now);
  syncBuiltinESMExports();
  setInterval(recorder.flush, WINDOW_MS * 5).unref();
}
