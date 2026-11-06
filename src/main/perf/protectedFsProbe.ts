/**
 * Lag probe (see src/shared/lagProbe.ts): names the code behind file calls and child processes
 * that touch a folder macOS guards with a privacy prompt (Documents, Desktop, Downloads, iCloud
 * Drive). Every such access asks sandboxd, which asks tccd; a few dozen a second for a few
 * minutes has frozen the whole Mac, and sync-fs.jsonl saw none of them, so this covers the
 * async calls, the sync stat family and child process working folders too.
 *
 * Appends to protected-fs.jsonl a line at a time, so lines survive a force quit. Every call
 * also gets a line in protected-fs-trace.jsonl before it runs, beside a once-a-second
 * `main-alive` line. When the main thread hangs, the last lines there show whether it stopped
 * inside one of these calls (a call line, then no more `main-alive`) or somewhere this probe
 * can't see (`main-alive` lines after the last call, then nothing).
 * Records the
 * operation, a class of path, the first two folder names below that class's root, and function
 * names. Never a file name, deeper folders or contents: paths can hold chat ids.
 */
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { captureFrames, createProbeLog } from './syncFsProbe';

const WINDOW_MS = 1_000;
/** A window with this many calls is logged by itself. */
const BURST_CALLS = 20;
const SUMMARY_EVERY_MS = 60_000;
/** Stacks for the first this many calls of a summary; later ones are only counted. */
const MAX_STACKS_PER_SUMMARY = 500;
const TOP_CALLERS = 8;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** The trace starts again past this size, keeping one older file. */
const MAX_TRACE_BYTES = 10 * 1024 * 1024;
const TRACE_FRAMES = 8;
const ALIVE_EVERY_MS = 1_000;
/** captureFrames, the frames callback, record, the report callback and the wrapper. */
const PROBE_FRAMES = 5;

/** Async calls: `fs.<op>` with a callback and `fs.promises.<op>`. */
const ASYNC_OPS = [
  'open',
  'readFile',
  'writeFile',
  'appendFile',
  'readdir',
  'opendir',
  'stat',
  'lstat',
  'access',
  'realpath',
  'mkdir',
  'rm',
  'rename',
  'copyFile',
  'cp',
  'unlink',
] as const;

/** Sync calls sync-fs.jsonl doesn't wrap, plus the ones it does, for protected paths only. */
const SYNC_OPS = [
  'existsSync',
  'statSync',
  'lstatSync',
  'accessSync',
  'realpathSync',
  'mkdirSync',
  'rmSync',
  'renameSync',
  'unlinkSync',
  'openSync',
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'readdirSync',
  'opendirSync',
  'copyFileSync',
  'watch',
  'watchFile',
] as const;

const SPAWN_OPS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

export interface ProtectedRoots {
  app: string;
  documents: string;
  desktop: string;
  downloads: string;
  home: string;
}

/** Where a protected path is, or null for a path macOS doesn't guard. */
export function classifyProtected(target: unknown, roots: ProtectedRoots): { pathClass: string; area: string } | null {
  let file: string;
  if (typeof target === 'string') file = target;
  else if (target instanceof URL) file = target.pathname;
  else if (Buffer.isBuffer(target)) file = target.toString('utf8');
  else return null;
  file = path.resolve(file);
  const iCloud = path.join(roots.home, 'Library', 'Mobile Documents');
  const guarded = [roots.documents, roots.desktop, roots.downloads, iCloud];
  if (!guarded.some((root) => file === root || file.startsWith(root + path.sep))) return null;
  // Specific to general: the checkout and its siblings sit under Documents in development.
  const classes: [string, string][] = [
    ['app-modules', path.join(roots.app, 'node_modules')],
    ['app', roots.app],
    ['app-sibling', path.dirname(roots.app)],
    ['documents', roots.documents],
    ['desktop', roots.desktop],
    ['downloads', roots.downloads],
    ['icloud', iCloud],
  ];
  for (const [pathClass, root] of classes) {
    if (file !== root && !file.startsWith(root + path.sep)) continue;
    const below = file === root ? [] : path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
    // Two folders, never the file's own name: enough to tell ../assistant/data from .vite.
    return { pathClass, area: below.slice(0, 2).join('/') };
  }
  return null;
}

interface RecorderDeps {
  now: () => number;
  write: (line: string) => void;
  /** Writes one trace line; called before each recorded call runs. */
  trace?: (line: string) => void;
  /** Function names, innermost first. */
  frames: () => string[];
  classify: (target: unknown) => { pathClass: string; area: string } | null;
}

export interface ProtectedFsRecorder {
  /** `targets` are the paths the call touches; the first protected one is recorded. */
  record(op: string, targets: unknown[]): void;
  /** Ends the current one-second window, logging it if it was a burst. */
  flushWindow(): void;
  /** Logs the callers since the last summary, if there were any. */
  flushSummary(): void;
  /** Writes a `main-alive` trace line. */
  alive(): void;
}

interface Caller {
  op: string;
  pathClass: string;
  area: string;
  frames: string[];
  calls: number;
}

export function createProtectedFsRecorder({ now, write, trace, frames, classify }: RecorderDeps): ProtectedFsRecorder {
  const probeLog = createProbeLog(write, MAX_LOG_BYTES);
  const log = probeLog.log;
  const traceLog = trace ? createProbeLog(trace, MAX_TRACE_BYTES) : null;

  let windowStart = now();
  let windowCalls = 0;
  let windowCallers = new Map<string, Caller>();
  let summaryStart = now();
  let summaryCalls = 0;
  let summaryCallers = new Map<string, Caller>();
  let unsampled = 0;

  const top = (callers: Map<string, Caller>) =>
    [...callers.values()].sort((a, b) => b.calls - a.calls).slice(0, TOP_CALLERS);

  const add = (callers: Map<string, Caller>, key: string, entry: Omit<Caller, 'calls'>) => {
    const caller = callers.get(key);
    if (caller) caller.calls++;
    else callers.set(key, { ...entry, calls: 1 });
  };

  const flushWindow = () => {
    if (windowCalls >= BURST_CALLS) {
      log({ kind: 'protected-fs-burst', windowMs: Math.round(now() - windowStart), calls: windowCalls, top: top(windowCallers) });
    }
    windowStart = now();
    windowCalls = 0;
    windowCallers = new Map();
  };

  const flushSummary = () => {
    if (summaryCalls > 0) {
      log({
        kind: 'protected-fs-summary',
        windowS: Math.round((now() - summaryStart) / 1000),
        calls: summaryCalls,
        unsampled,
        top: top(summaryCallers),
      });
    }
    summaryStart = now();
    summaryCalls = 0;
    summaryCallers = new Map();
    unsampled = 0;
  };

  const record = (op: string, targets: unknown[]) => {
    if (probeLog.writing() || traceLog?.writing()) return;
    let place: { pathClass: string; area: string } | null = null;
    for (const target of targets) {
      place = classify(target);
      if (place) break;
    }
    if (!place) return;
    if (now() - windowStart >= WINDOW_MS) flushWindow();
    if (now() - summaryStart >= SUMMARY_EVERY_MS) flushSummary();
    windowCalls++;
    summaryCalls++;
    // A flood is many calls from few places, so stacks for the first calls of a minute name it.
    if (summaryCalls > MAX_STACKS_PER_SUMMARY) {
      unsampled++;
      traceLog?.log({ kind: 'protected-fs-call', op, ...place });
      return;
    }
    const stack = frames();
    traceLog?.log({ kind: 'protected-fs-call', op, ...place, frames: stack.slice(0, TRACE_FRAMES) });
    const key = `${op}|${place.pathClass}|${place.area}|${stack.join('<')}`;
    const entry = { op, ...place, frames: stack };
    add(windowCallers, key, entry);
    add(summaryCallers, key, entry);
  };

  const alive = () => traceLog?.log({ kind: 'main-alive' });

  return { record, flushWindow, flushSummary, alive };
}

type AnyFn = (...args: unknown[]) => unknown;

/** Calls made while another wrapped call runs (exec runs spawn) report once. */
export interface Nesting {
  depth: number;
}

function wrapOne(
  original: AnyFn,
  op: string,
  report: (op: string, args: unknown[]) => void,
  nesting: Nesting
): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    if (nesting.depth === 0) {
      try {
        report(op, args);
      } catch {
        /* A probe must not break the call it watches. */
      }
    }
    nesting.depth++;
    try {
      return original.apply(this, args);
    } finally {
      nesting.depth--;
    }
  };
}

/** Replaces `ops` on `target` with versions that report their paths first. */
export function wrapCalls(
  target: object,
  ops: readonly string[],
  report: (op: string, args: unknown[]) => void,
  nesting: Nesting,
  prefix = ''
): void {
  const methods = target as Record<string, AnyFn>;
  for (const op of ops) {
    const original = methods[op];
    if (typeof original !== 'function') continue;
    const wrapped = wrapOne(original, prefix + op, report, nesting);
    // fs.realpath.native and the like. Node's own promisify.custom is not configurable.
    const descriptors = Object.getOwnPropertyDescriptors(original) as Record<PropertyKey, PropertyDescriptor>;
    delete descriptors[promisify.custom];
    Object.defineProperties(wrapped, descriptors);
    // exec and execFile have their own promisified form, which promisify(execFile) returns.
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === 'function') {
      Object.defineProperty(wrapped, promisify.custom, {
        value: wrapOne(custom as AnyFn, prefix + op, report, nesting),
      });
    }
    methods[op] = wrapped;
  }
}

/** Calls whose second argument is also a path. For the rest it's options, such as 'utf8'. */
const TWO_PATH_OPS = new Set(['rename', 'copyFile', 'cp', 'renameSync', 'copyFileSync']);

/** The paths a file call touches. `op` may carry the 'promises.' prefix. */
export function fsTargets(op: string, args: unknown[]): unknown[] {
  return TWO_PATH_OPS.has(op.replace(/^promises\./, '')) ? args.slice(0, 2) : args.slice(0, 1);
}

/**
 * The paths a child process touches: its working folder (inherited from this process when
 * none is given) and, for spawn, execFile and fork, the program itself.
 */
export function spawnTargets(op: string, args: unknown[], cwd: () => string): unknown[] {
  const options = args.find(
    (arg): arg is { cwd?: unknown } => typeof arg === 'object' && arg !== null && !Array.isArray(arg)
  );
  const folder = options?.cwd ?? cwd();
  const runsFile = !op.startsWith('exec') || op.startsWith('execFile');
  return runsFile ? [folder, args[0]] : [folder];
}

/** Starts recording this process's protected-folder file calls and child processes to `logFile`. */
export function installProtectedFsProbe(logFile: string, traceFile: string, roots: ProtectedRoots): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const { appendFileSync } = fs;
  rotateIfLarge(traceFile, MAX_TRACE_BYTES);
  const now = () => performance.now();
  const recorder = createProtectedFsRecorder({
    now,
    write: (line) => appendFileSync(logFile, line, 'utf8'),
    trace: (line) => appendFileSync(traceFile, line, 'utf8'),
    frames: () => captureFrames(PROBE_FRAMES),
    classify: (target) => classifyProtected(target, roots),
  });
  const nesting: Nesting = { depth: 0 };
  const reportFs = (op: string, args: unknown[]) => recorder.record(op, fsTargets(op, args));
  const reportSpawn = (op: string, args: unknown[]) =>
    recorder.record(op, spawnTargets(op, args, () => process.cwd()));
  wrapCalls(fs, ASYNC_OPS, reportFs, nesting);
  wrapCalls(fs, SYNC_OPS, reportFs, nesting);
  wrapCalls(fs.promises, ASYNC_OPS, reportFs, nesting, 'promises.');
  wrapCalls(childProcess, SPAWN_OPS, reportSpawn, nesting);
  syncBuiltinESMExports();
  setInterval(recorder.flushWindow, WINDOW_MS * 5).unref();
  setInterval(recorder.flushSummary, SUMMARY_EVERY_MS).unref();
  recorder.alive();
  setInterval(recorder.alive, ALIVE_EVERY_MS).unref();
}

/** Moves `file` to `<name>.1.jsonl` when it's over `maxBytes`, replacing the older one. */
export function rotateIfLarge(file: string, maxBytes: number): void {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
  } catch {
    /* No file yet, or it can't be moved: keep appending. */
  }
}
