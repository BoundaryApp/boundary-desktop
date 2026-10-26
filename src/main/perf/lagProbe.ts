/**
 * Lag probe, main-process side (see src/shared/lagProbe.ts).
 *
 * Import this first in src/main/index.ts: it times every ipcMain.handle handler, so it
 * has to patch ipcMain before any handler is registered.
 *
 * Writes ~/Library/Logs/Boundary/lag-probe/lag-probe.jsonl (one JSON object per line) and,
 * around a severe stall, traces/trace-<time>.perfetto-trace (Perfetto protobuf; open in
 * ui.perfetto.dev) and traces/main-<time>.cpuprofile (main-process JS; open in DevTools ›
 * Performance).
 */
import { app, contentTracing, ipcMain, session, type BrowserWindow, type WebContents } from 'electron';
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  endLagLog,
  lagLog,
  lagLogDir,
  lagProbeEnabled,
  lagProbeTracing,
  lagTraceDir,
} from './lagLog';
import { MemoryTrend, type SeriesRule } from './memoryTrend';
import {
  LAG_PROBE_CHANNELS,
  LAG_THRESHOLDS,
  type LagProbeConfig,
  type LagProbeReport,
} from '../../shared/lagProbe';

const enabled = lagProbeEnabled;
const tracing = lagProbeTracing;
const logDir = lagLogDir;
const traceDir = lagTraceDir;

const SUMMARY_EVERY_MS = 60_000;
const STALL_TICK_MS = 50;
/** Wait this long after a severe stall before saving, so the trace shows its aftermath. */
const DUMP_DELAY_MS = 1_500;
/** Automatic saves at most this often; a manual mark always saves. */
const DUMP_MIN_GAP_MS = 45_000;
const KEEP_TRACE_FILES = 24;
const PROFILE_WINDOW_MS = 30_000;

const startedAt = performance.now();

// ── IPC timing ───────────────────────────────────────────────────────────────────────

interface ChannelStats {
  calls: number;
  syncMs: number;
  maxSyncMs: number;
  totalMs: number;
}

const ipcStats = new Map<string, ChannelStats>();
const inflight = new Map<string, number>();
/** Last handler runs, newest last: what main was doing just before a stall. */
const recentIpc: { channel: string; syncMs: number; endedAt: number }[] = [];
const sendCounts = new Map<string, number>();

function statsFor(channel: string): ChannelStats {
  let stats = ipcStats.get(channel);
  if (!stats) {
    stats = { calls: 0, syncMs: 0, maxSyncMs: 0, totalMs: 0 };
    ipcStats.set(channel, stats);
  }
  return stats;
}

function bump(map: Map<string, number>, key: string, by: number): void {
  const next = (map.get(key) ?? 0) + by;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

type Handler = Parameters<typeof ipcMain.handle>[1];

// ── IPC results ──────────────────────────────────────────────────────────────────────

type Summary = Record<string, unknown>;

function countBy<T>(items: T[], key: (item: T) => unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = String(key(item) ?? 'none');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function projectsSummary(r: Summary): Summary {
  const projects = Array.isArray(r.projects) ? r.projects : null;
  return {
    success: r.success,
    error: r.error,
    projects: projects?.length,
    activeId: r.activeId,
    connecting: r.connecting,
    rpcAvailable: r.rpcAvailable,
  };
}

/**
 * What the rail and project pages are built from. Each result is logged as `ipc-result`
 * when its summary differs from that channel's previous one, so a list that empties and
 * refills shows up as two entries.
 */
const RESULT_SUMMARIES: Record<string, (r: Summary) => Summary> = {
  'hermes-chat:list-threads': (r) => {
    const threads = Array.isArray(r.threads) ? (r.threads as Summary[]) : null;
    return {
      success: r.success,
      error: r.error,
      threads: threads?.length,
      byKind: threads ? countBy(threads, (t) => t.kind) : undefined,
      byProject: threads ? countBy(threads, (t) => t.projectId) : undefined,
    };
  },
  'hermes-channels:list': (r) => ({
    success: r.success,
    error: r.error,
    channels: Array.isArray(r.channels) ? r.channels.length : undefined,
  }),
  'hermes-agents:list': (r) => ({
    success: r.success,
    error: r.error,
    agents: Array.isArray(r.agents) ? r.agents.length : undefined,
  }),
  'hermes-projects:list': projectsSummary,
  'hermes-projects:select': projectsSummary,
};

const lastResult = new Map<string, string>();

function logResult(channel: string, result: unknown, ms: number): void {
  const summarize = RESULT_SUMMARIES[channel];
  if (!summarize || !result || typeof result !== 'object') return;
  let summary: Summary;
  try {
    summary = summarize(result as Summary);
  } catch {
    return;
  }
  const key = JSON.stringify(summary);
  if (lastResult.get(channel) === key) return;
  lastResult.set(channel, key);
  lagLog({ proc: 'main', kind: 'ipc-result', channel, ms: round(ms), ...summary });
}

function timeHandler(channel: string, listener: Handler): Handler {
  return function timed(this: unknown, ...args: Parameters<Handler>) {
    const t0 = performance.now();
    bump(inflight, channel, 1);
    const done = () => {
      bump(inflight, channel, -1);
      statsFor(channel).totalMs += performance.now() - t0;
    };
    let result: unknown;
    try {
      result = listener.apply(this, args);
    } catch (err) {
      done();
      throw err;
    } finally {
      const syncMs = performance.now() - t0;
      const stats = statsFor(channel);
      stats.calls += 1;
      stats.syncMs += syncMs;
      stats.maxSyncMs = Math.max(stats.maxSyncMs, syncMs);
      recentIpc.push({ channel, syncMs: round(syncMs), endedAt: performance.now() });
      if (recentIpc.length > 40) recentIpc.shift();
      if (syncMs >= LAG_THRESHOLDS.ipcSync) {
        lagLog({ proc: 'main', kind: 'ipc-slow-sync', channel, ms: round(syncMs) });
      }
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return Promise.resolve(result)
        .then((value) => {
          logResult(channel, value, performance.now() - t0);
          return value;
        })
        .finally(done);
    }
    done();
    logResult(channel, result, performance.now() - t0);
    return result;
  } as Handler;
}

function installIpcTiming(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  const handleOnce = ipcMain.handleOnce.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, timeHandler(channel, listener));
  ipcMain.handleOnce = (channel, listener) => handleOnce(channel, timeHandler(channel, listener));
}

/** Count main → renderer events per channel (streaming replies, status pushes). */
function countSends(contents: WebContents): void {
  const send = contents.send.bind(contents);
  contents.send = (channel: string, ...args: unknown[]) => {
    bump(sendCounts, channel, 1);
    send(channel, ...args);
  };
}

// ── Main event loop stalls ───────────────────────────────────────────────────────────

/** When the probe last did its own heavy work, so its stalls are labelled. */
let probeWorkEndedAt = -Infinity;
const loopDelay = monitorEventLoopDelay({ resolution: 20 });

function startStallDetector(): void {
  loopDelay.enable();
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - STALL_TICK_MS;
    if (lag >= LAG_THRESHOLDS.mainStall) {
      const from = now - lag;
      const entry = {
        proc: 'main',
        kind: 'main-stall',
        ms: round(lag),
        appReady: app.isReady(),
        sinceStartS: round((now - startedAt) / 1000),
        probe: probeWorkEndedAt >= last && probeWorkEndedAt <= now,
        inflight: Object.fromEntries(inflight),
        // Handlers that finished inside the stall ran (part of) it.
        ipcDuring: recentIpc.filter((r) => r.endedAt >= from).map(({ channel, syncMs }) => ({
          channel,
          syncMs,
        })),
      };
      lagLog(entry);
      if (lag >= LAG_THRESHOLDS.severe && !entry.probe && app.isReady()) {
        requestDump(entry);
      }
    }
    last = now;
  }, STALL_TICK_MS);
  timer.unref();
}

// ── Flight recorders ─────────────────────────────────────────────────────────────────

/** DevTools Performance-panel categories, plus input latency, compositor and GPU. */
const TRACE_CONFIG: Electron.TraceConfig = {
  recording_mode: 'record-continuously',
  trace_buffer_size_in_kb: 96 * 1024,
  included_categories: [
    'devtools.timeline',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'v8.execute',
    'v8',
    'blink',
    'blink.user_timing',
    'blink.console',
    'loading',
    'latencyInfo',
    'input',
    'toplevel',
    'benchmark',
    'cc',
    'gpu',
    'viz',
    'renderer.scheduler',
    'electron',
  ],
  excluded_categories: ['*'],
};

let traceRunning = false;

async function startTrace(): Promise<void> {
  if (!tracing || traceRunning) return;
  try {
    await contentTracing.startRecording(TRACE_CONFIG);
    traceRunning = true;
  } catch (err) {
    lagLog({ proc: 'main', kind: 'probe-error', where: 'trace-start', error: String(err) });
  }
}

/** Rolling main-process CPU profile: kept in memory, written only when a stall is saved. */
const mainProfiler = (() => {
  let inspectorSession: inspector.Session | null = null;
  let windowStartedAt = 0;
  let previous: unknown = null;

  const post = <T>(method: string, params?: object) =>
    new Promise<T>((resolve, reject) => {
      inspectorSession!.post(method, params ?? {}, (err, result) =>
        err ? reject(err) : resolve(result as T)
      );
    });

  async function begin(): Promise<void> {
    await post('Profiler.start');
    windowStartedAt = Date.now();
  }

  async function end(): Promise<unknown> {
    const { profile } = await post<{ profile: unknown }>('Profiler.stop');
    probeWorkEndedAt = performance.now();
    return profile;
  }

  return {
    async start(): Promise<void> {
      try {
        inspectorSession = new inspector.Session();
        inspectorSession.connect();
        await post('Profiler.enable');
        await post('Profiler.setSamplingInterval', { interval: 1000 });
        await begin();
        setInterval(() => {
          void (async () => {
            previous = await end();
            await begin();
          })().catch((): void => undefined);
        }, PROFILE_WINDOW_MS).unref();
      } catch (err) {
        inspectorSession = null;
        lagLog({ proc: 'main', kind: 'probe-error', where: 'profiler-start', error: String(err) });
      }
    },
    /** Write the current window (and the one before, if this one is young). */
    async save(base: string): Promise<string[]> {
      if (!inspectorSession) return [];
      const youngWindow = Date.now() - windowStartedAt < 10_000;
      const current = await end();
      await begin();
      const files: [string, unknown][] = [[`${base}.cpuprofile`, current]];
      if (youngWindow && previous) files.push([`${base}-before.cpuprofile`, previous]);
      for (const [file, profile] of files) {
        await fs.promises.writeFile(file, JSON.stringify(profile));
      }
      probeWorkEndedAt = performance.now();
      return files.map(([file]) => file);
    },
  };
})();

let dumpTimer: ReturnType<typeof setTimeout> | null = null;
let lastDumpAt = -Infinity;
let pendingReasons: unknown[] = [];

function requestDump(reason: { kind: string; [key: string]: unknown }, manual = false): void {
  if (!tracing || !traceDir) return;
  if (!manual && Date.now() - lastDumpAt < DUMP_MIN_GAP_MS && !dumpTimer) return;
  pendingReasons.push(reason);
  if (dumpTimer) return;
  dumpTimer = setTimeout(() => void dump(), DUMP_DELAY_MS);
}

async function dump(): Promise<void> {
  const reasons = pendingReasons;
  pendingReasons = [];
  dumpTimer = null;
  lastDumpAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const saved: string[] = [];
  if (traceRunning) {
    traceRunning = false;
    try {
      saved.push(
        await contentTracing.stopRecording(path.join(traceDir!, `trace-${stamp}.perfetto-trace`))
      );
    } catch (err) {
      lagLog({ proc: 'main', kind: 'probe-error', where: 'trace-stop', error: String(err) });
    }
    void startTrace();
  }
  try {
    saved.push(...(await mainProfiler.save(path.join(traceDir!, `main-${stamp}`))));
  } catch (err) {
    lagLog({ proc: 'main', kind: 'probe-error', where: 'profile-save', error: String(err) });
  }
  lagLog({ proc: 'main', kind: 'recording-saved', files: saved, reasons }, true);
  void pruneRecordings();
}

async function pruneRecordings(): Promise<void> {
  try {
    // trace-<stamp>.perfetto-trace, main-<stamp>.cpuprofile, main-<stamp>-before.cpuprofile
    const stampOf = (name: string) =>
      name.replace(/^(trace|main)-/, '').split('.')[0].replace(/-before$/, '');
    const names = (await fs.promises.readdir(traceDir!)).filter(
      (n) => n.startsWith('trace-') || n.startsWith('main-')
    );
    const keep = new Set([...new Set(names.map(stampOf))].sort().slice(-KEEP_TRACE_FILES));
    for (const name of names) {
      if (!keep.has(stampOf(name))) await fs.promises.unlink(path.join(traceDir!, name));
    }
  } catch {
    /* best effort */
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────────────

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

// ── Memory over time ─────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
/** Log every series' trend this often; growth warnings go out as soon as they're found. */
const MEMORY_TREND_EVERY = 5;

function memoryRule(series: string): SeriesRule {
  if (series.endsWith(':domNodes')) return { minGrowth: 2_000, minRatio: 0.3 };
  if (series.includes('heap')) return { minGrowth: 30, minRatio: 0.25 };
  return { minGrowth: 100, minRatio: 0.25 };
}

const memoryTrend = new MemoryTrend(memoryRule);
let summaries = 0;

function sampleMainMemory(): Record<string, number> {
  const usage = process.memoryUsage();
  const memory = {
    rssMB: Math.round(usage.rss / MB),
    heapUsedMB: Math.round(usage.heapUsed / MB),
    heapTotalMB: Math.round(usage.heapTotal / MB),
    externalMB: Math.round(usage.external / MB),
    arrayBuffersMB: Math.round(usage.arrayBuffers / MB),
  };
  memoryTrend.add('main:heapUsed', usage.heapUsed / MB, 'MB');
  memoryTrend.add('main:rss', usage.rss / MB, 'MB');
  memoryTrend.add('main:external', usage.external / MB, 'MB');
  return memory;
}

function sampleProcessMemory(metrics: Electron.ProcessMetric[]): void {
  const live = new Set<string>();
  for (const m of metrics) {
    const series = `process:${m.type}${m.name ? `:${m.name}` : ''}:${m.pid}`;
    live.add(series);
    memoryTrend.add(series, m.memory.workingSetSize / 1024, 'MB');
  }
  for (const series of memoryTrend.seriesNames()) {
    if (series.startsWith('process:') && !live.has(series)) memoryTrend.drop(series);
  }
}

/** Fed from each renderer's per-minute summary. */
function sampleRendererMemory(senderId: number, report: LagProbeReport): void {
  if (typeof report.heapMB === 'number') {
    memoryTrend.add(`renderer:${senderId}:heap`, report.heapMB, 'MB');
  }
  if (typeof report.domNodes === 'number') {
    memoryTrend.add(`renderer:${senderId}:domNodes`, report.domNodes, 'elements');
  }
}

function checkMemory(): void {
  for (const trend of memoryTrend.newFindings()) {
    lagLog({ proc: 'main', kind: 'memory-growth', ...trend }, true);
  }
  summaries += 1;
  if (summaries % MEMORY_TREND_EVERY === 0) {
    lagLog({ proc: 'main', kind: 'memory-trend', trends: memoryTrend.trends() }, true);
  }
}

function writeSummary(): void {
  const nsToMs = (ns: number) => round(ns / 1e6);
  const channels = [...ipcStats.entries()]
    .sort((a, b) => b[1].syncMs - a[1].syncMs || b[1].calls - a[1].calls)
    .slice(0, 12)
    .map(([channel, s]) => ({
      channel,
      calls: s.calls,
      syncMs: round(s.syncMs),
      maxSyncMs: round(s.maxSyncMs),
      avgTotalMs: round(s.totalMs / Math.max(1, s.calls)),
    }));
  const sends = [...sendCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([channel, count]) => ({ channel, count }));
  let processes: unknown = null;
  try {
    const metrics = app.getAppMetrics();
    sampleProcessMemory(metrics);
    processes = metrics.map((m) => ({
      type: m.type,
      name: m.name ?? m.serviceName,
      pid: m.pid,
      cpu: round(m.cpu.percentCPUUsage),
      idleWakeups: m.cpu.idleWakeupsPerSecond,
      memMB: Math.round(m.memory.workingSetSize / 1024),
    }));
  } catch {
    /* not ready */
  }
  lagLog({
    proc: 'main',
    kind: 'main-summary',
    windowS: SUMMARY_EVERY_MS / 1000,
    loopDelayMs: {
      p50: nsToMs(loopDelay.percentile(50)),
      p99: nsToMs(loopDelay.percentile(99)),
      max: nsToMs(loopDelay.max),
    },
    memory: sampleMainMemory(),
    ipcBySyncTime: channels,
    sendsToRenderer: sends,
    processes,
  });
  loopDelay.reset();
  ipcStats.clear();
  sendCounts.clear();
  checkMemory();
}

// ── Wiring ───────────────────────────────────────────────────────────────────────────

ipcMain.handle(
  LAG_PROBE_CHANNELS.config,
  (): LagProbeConfig => ({ enabled, tracing, logDir })
);

if (enabled) {
  // performance.memory in the page is otherwise rounded into coarse buckets.
  app.commandLine.appendSwitch('enable-precise-memory-info');
  installIpcTiming();
  startStallDetector();

  app.on('web-contents-created', (_event, contents) => countSends(contents));
  app.on('browser-window-created', (_event, win: BrowserWindow) => {
    win.on('unresponsive', () => {
      lagLog({ proc: 'main', kind: 'window-unresponsive' }, true);
      requestDump({ kind: 'window-unresponsive' }, true);
    });
    win.on('responsive', () => lagLog({ proc: 'main', kind: 'window-responsive' }, true));
  });
  app.on('accessibility-support-changed', (_event, on) =>
    lagLog({ proc: 'main', kind: 'accessibility-support-changed', enabled: on }, true)
  );
  app.on('child-process-gone', (_event, details) =>
    lagLog({ proc: 'main', kind: 'child-process-gone', ...details }, true)
  );

  ipcMain.on(LAG_PROBE_CHANNELS.report, (event, report: LagProbeReport) => {
    if (!report || typeof report.kind !== 'string') return;
    lagLog({ proc: 'renderer', ...report });
    if (report.kind === 'renderer-summary') sampleRendererMemory(event.sender.id, report);
    if (report.severe) requestDump({ kind: report.kind, ms: report.ms });
  });
  ipcMain.on(LAG_PROBE_CHANNELS.mark, (_event, note: unknown) => {
    const entry = { proc: 'renderer', kind: 'mark', note: typeof note === 'string' ? note : '' };
    lagLog(entry, true);
    requestDump(entry, true);
  });
  app.on('before-quit', endLagLog);
}

/** Call once the app is ready: logs the environment and starts the recorders. */
export function startLagProbe(): void {
  if (!enabled) return;
  let spellcheck: unknown = null;
  try {
    spellcheck = {
      enabled: session.defaultSession.isSpellCheckerEnabled(),
      languages: session.defaultSession.getSpellCheckerLanguages(),
    };
  } catch {
    /* older Electron */
  }
  lagLog(
    {
      proc: 'main',
      kind: 'probe-start',
      tracing,
      logDir,
      isPackaged: app.isPackaged,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      // A11y clients (Grammarly, window managers, password managers) turn this on and
      // make every DOM change more expensive.
      accessibilitySupport: app.isAccessibilitySupportEnabled(),
      spellcheck,
      gpu: app.getGPUFeatureStatus(),
      readyAfterS: round((performance.now() - startedAt) / 1000),
    },
    true
  );
  setInterval(writeSummary, SUMMARY_EVERY_MS).unref();
  if (tracing) {
    void startTrace();
    void mainProfiler.start();
  }
}
