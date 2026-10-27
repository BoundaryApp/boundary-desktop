/**
 * Lag probe, renderer side (see src/shared/lagProbe.ts). Measures what the user feels
 * and reports it to main, which logs it and saves the flight recorders on a bad one:
 *
 * - slow-event: keystroke/click to next paint (Event Timing), split into input delay
 *   (waiting to run: busy renderer, or a busy main process holding the input back),
 *   processing (our handlers), and presentation (render, layout, paint).
 * - slow-frame: a long animation frame and the scripts that ran in it (LoAF).
 * - frame-gap: no frame for a while during typing or scrolling. With no slow-frame
 *   alongside, the renderer was idle: look at main, the GPU process or the compositor.
 * - wheel-delay: a wheel event reached the page late (input held up before the renderer).
 * - react-commit: one slow React commit, by <Profiler> id.
 * - dom-removed: large parts of the page removed (a list or pane going away).
 * - renderer-summary: once a minute.
 *
 * In the DevTools console: `__lagProbe.mark('note')` logs a mark and saves the recorders.
 * The same from the keyboard: ⌘⌥⇧L.
 */
import type { ProfilerOnRenderCallback } from 'react';
import { LAG_THRESHOLDS, type LagProbeReport, roundTenth } from '../../shared/lagProbe';

interface EventTimingEntry extends PerformanceEntry {
  processingStart: number;
  processingEnd: number;
  interactionId?: number;
  target?: EventTarget | null;
}

interface LoafScript {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration: number;
  forcedStyleAndLayoutDuration?: number;
  pauseDuration?: number;
}

interface LoafEntry extends PerformanceEntry {
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts?: LoafScript[];
}

const SUMMARY_EVERY_MS = 60_000;
/** Watch frames this long after the last key, wheel or scroll. */
const ACTIVE_WINDOW_MS = 1_000;

let active = false;

const last = { key: -Infinity, scroll: -Infinity, pointer: -Infinity };

const totals = {
  events: 0,
  slowEvents: 0,
  worstEventMs: 0,
  slowFrames: 0,
  slowFrameBlockingMs: 0,
  worstFrameMs: 0,
  frameGaps: 0,
  worstFrameGapMs: 0,
  wheelDelays: 0,
  react: new Map<string, { commits: number; ms: number; max: number }>(),
};


function epoch(perfTime: number): number {
  return Math.round(performance.timeOrigin + perfTime);
}

function activity(now = performance.now()): string {
  const recent = (at: number) => now - at < ACTIVE_WINDOW_MS;
  const kinds = [
    recent(last.key) && 'typing',
    recent(last.scroll) && 'scrolling',
    recent(last.pointer) && 'pointer',
  ].filter(Boolean);
  return kinds.length ? kinds.join('+') : 'idle';
}

function describe(node: unknown): string | null {
  if (!(node instanceof Element)) return null;
  const classes = [...node.classList].slice(0, 2).map((c) => `.${c}`).join('');
  return `${node.tagName.toLowerCase()}${classes}`;
}

/** Cheap page context for a report: what was on screen and what had focus. */
function context(): Record<string, unknown> {
  return {
    activity: activity(),
    focus: describe(document.activeElement),
    messages: document.querySelectorAll('.wb-msg').length,
    hidden: document.visibilityState === 'hidden',
  };
}

function report(entry: LagProbeReport): void {
  if (!active) return;
  try {
    window.boundaryLagProbe?.report(entry);
  } catch {
    /* never break the page */
  }
  const line = `[lag-probe] ${entry.kind}${entry.ms != null ? ` ${Math.round(entry.ms)}ms` : ''}`;
  if (entry.severe) console.warn(line, entry);
  else console.debug(line, entry);
}

function observeEvents(): void {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as EventTimingEntry[]) {
      totals.events += 1;
      if (entry.duration < LAG_THRESHOLDS.event) continue;
      totals.slowEvents += 1;
      totals.worstEventMs = Math.max(totals.worstEventMs, entry.duration);
      report({
        kind: 'slow-event',
        at: epoch(entry.startTime),
        ms: entry.duration,
        event: entry.name,
        interactionId: entry.interactionId,
        inputDelayMs: roundTenth(entry.processingStart - entry.startTime),
        processingMs: roundTenth(entry.processingEnd - entry.processingStart),
        presentationMs: roundTenth(entry.startTime + entry.duration - entry.processingEnd),
        target: describe(entry.target),
        severe: entry.duration >= LAG_THRESHOLDS.severe,
        ...context(),
      });
    }
  });
  observer.observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit);
}

function observeFrames(): void {
  if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
    report({ kind: 'probe-error', at: Date.now(), where: 'long-animation-frame unsupported' });
    return;
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LoafEntry[]) {
      if (entry.duration < LAG_THRESHOLDS.frame) continue;
      totals.slowFrames += 1;
      totals.slowFrameBlockingMs += entry.blockingDuration;
      totals.worstFrameMs = Math.max(totals.worstFrameMs, entry.duration);
      const end = entry.startTime + entry.duration;
      const scripts = (entry.scripts ?? [])
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 4)
        .map((s) => ({
          ms: roundTenth(s.duration),
          invoker: s.invoker,
          type: s.invokerType,
          fn: s.sourceFunctionName || undefined,
          src: s.sourceURL ? `${s.sourceURL.split('/').pop()}:${s.sourceCharPosition}` : undefined,
          forcedLayoutMs: s.forcedStyleAndLayoutDuration
            ? roundTenth(s.forcedStyleAndLayoutDuration)
            : undefined,
        }));
      report({
        kind: 'slow-frame',
        at: epoch(entry.startTime),
        ms: entry.duration,
        blockingMs: roundTenth(entry.blockingDuration),
        scriptMs: roundTenth((entry.scripts ?? []).reduce((sum, s) => sum + s.duration, 0)),
        // Style, layout and paint at the end of the frame.
        renderMs: entry.renderStart ? roundTenth(end - entry.renderStart) : 0,
        styleLayoutMs: entry.styleAndLayoutStart ? roundTenth(end - entry.styleAndLayoutStart) : 0,
        scripts,
        severe: entry.duration >= LAG_THRESHOLDS.severe,
        ...context(),
      });
    }
  });
  observer.observe({ type: 'long-animation-frame', buffered: false });
}

/** rAF loop that runs only while the user is typing or scrolling. */
const frameWatch = (() => {
  let running = false;
  let previous = 0;
  const tick = (now: number) => {
    const gap = now - previous;
    if (gap >= LAG_THRESHOLDS.frameGap && document.visibilityState === 'visible') {
      totals.frameGaps += 1;
      totals.worstFrameGapMs = Math.max(totals.worstFrameGapMs, gap);
      report({
        kind: 'frame-gap',
        at: epoch(previous),
        ms: roundTenth(gap),
        severe: gap >= LAG_THRESHOLDS.severe,
        ...context(),
      });
    }
    previous = now;
    const lastActive = Math.max(last.key, last.scroll, last.pointer);
    if (now - lastActive < ACTIVE_WINDOW_MS) requestAnimationFrame(tick);
    else running = false;
  };
  return {
    poke(): void {
      if (running) return;
      running = true;
      previous = performance.now();
      requestAnimationFrame(tick);
    },
  };
})();

function watchActivity(): void {
  const options = { capture: true, passive: true } as const;
  let lastWheelReport = 0;
  document.addEventListener(
    'keydown',
    (event) => {
      last.key = performance.now();
      frameWatch.poke();
      if (event.metaKey && event.altKey && event.shiftKey && event.code === 'KeyL') {
        mark('⌘⌥⇧L');
      }
    },
    options
  );
  document.addEventListener(
    'wheel',
    (event) => {
      const now = performance.now();
      last.scroll = now;
      frameWatch.poke();
      const delay = now - event.timeStamp;
      if (delay >= LAG_THRESHOLDS.frameGap && now - lastWheelReport > 250) {
        lastWheelReport = now;
        totals.wheelDelays += 1;
        report({
          kind: 'wheel-delay',
          at: epoch(event.timeStamp),
          ms: roundTenth(delay),
          severe: delay >= LAG_THRESHOLDS.severe,
          ...context(),
        });
      }
    },
    options
  );
  document.addEventListener(
    'scroll',
    () => {
      last.scroll = performance.now();
      frameWatch.poke();
    },
    options
  );
  document.addEventListener(
    'pointerdown',
    () => {
      last.pointer = performance.now();
      frameWatch.poke();
    },
    options
  );
}

/** A removed subtree this big is a list or pane going away, not a text update. */
const DOM_REMOVAL_MIN_ELEMENTS = 30;

function pathOf(node: Element | null): string {
  const parts: string[] = [];
  for (let n = node; n && n !== document.body && parts.length < 4; n = n.parentElement) {
    parts.unshift(describe(n) ?? '?');
  }
  return parts.join(' > ');
}

/**
 * Logs large subtrees leaving the page (a rail list, a pane, a whole screen), batched per
 * second. Catches remounts and lists that empty out, whatever state caused them.
 */
function watchDomRemovals(): void {
  let batch: { path: string; elements: number }[] = [];
  let flushTimer: number | null = null;
  const flush = () => {
    flushTimer = null;
    const removed = batch.sort((a, b) => b.elements - a.elements).slice(0, 6);
    const total = batch.length;
    batch = [];
    report({ kind: 'dom-removed', at: Date.now(), subtrees: total, removed, ...context() });
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        const elements = node.getElementsByTagName('*').length + 1;
        if (elements < DOM_REMOVAL_MIN_ELEMENTS) continue;
        const parent = record.target instanceof Element ? record.target : null;
        batch.push({ path: `${pathOf(parent)} > ${describe(node)}`, elements });
      }
    }
    if (batch.length && flushTimer === null) flushTimer = window.setTimeout(flush, 1000);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function writeSummary(): void {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const react = [...totals.react.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 10)
    .map(([id, r]) => ({ id, commits: r.commits, ms: roundTenth(r.ms), maxMs: roundTenth(r.max) }));
  report({
    kind: 'renderer-summary',
    at: Date.now(),
    windowS: SUMMARY_EVERY_MS / 1000,
    events: totals.events,
    slowEvents: totals.slowEvents,
    worstEventMs: totals.worstEventMs,
    slowFrames: totals.slowFrames,
    slowFrameBlockingMs: roundTenth(totals.slowFrameBlockingMs),
    worstFrameMs: totals.worstFrameMs,
    frameGaps: totals.frameGaps,
    worstFrameGapMs: roundTenth(totals.worstFrameGapMs),
    wheelDelays: totals.wheelDelays,
    react,
    heapMB: memory ? Math.round(memory.usedJSHeapSize / 1024 / 1024) : null,
    domNodes: document.getElementsByTagName('*').length,
    messages: document.querySelectorAll('.wb-msg').length,
  });
  Object.assign(totals, {
    events: 0,
    slowEvents: 0,
    worstEventMs: 0,
    slowFrames: 0,
    slowFrameBlockingMs: 0,
    worstFrameMs: 0,
    frameGaps: 0,
    worstFrameGapMs: 0,
    wheelDelays: 0,
  });
  totals.react.clear();
}

/**
 * A state change worth seeing next to the timings (what the rail shows, which screen is
 * up). Logged only; never saves the recorders.
 */
export function probeLog(kind: string, data: Record<string, unknown>): void {
  if (!active) return;
  try {
    window.boundaryLagProbe?.report({ kind, at: Date.now(), ...data });
  } catch {
    /* never break the page */
  }
}

/** Note a lag you just felt, and save the recorders around it. */
export function mark(note = ''): void {
  if (!active) return;
  window.boundaryLagProbe?.mark(note);
  console.warn(`[lag-probe] mark ${note}`);
}

/** <Profiler onRender>: counts every commit, reports slow ones. */
export const onReactRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  if (!active) return;
  const stats = totals.react.get(id) ?? { commits: 0, ms: 0, max: 0 };
  stats.commits += 1;
  stats.ms += actualDuration;
  stats.max = Math.max(stats.max, actualDuration);
  totals.react.set(id, stats);
  if (actualDuration < LAG_THRESHOLDS.reactCommit) return;
  report({
    kind: 'react-commit',
    at: Date.now(),
    ms: roundTenth(actualDuration),
    id,
    phase,
    activity: activity(),
  });
};

export async function installLagProbe(): Promise<void> {
  const bridge = window.boundaryLagProbe;
  if (!bridge || active) return;
  const config = await bridge.config().catch((): null => null);
  if (!config?.enabled) return;
  active = true;
  try {
    observeEvents();
    observeFrames();
  } catch (err) {
    report({ kind: 'probe-error', at: Date.now(), where: 'observe', error: String(err) });
  }
  watchActivity();
  watchDomRemovals();
  window.setInterval(writeSummary, SUMMARY_EVERY_MS);
  (window as Window & { __lagProbe?: unknown }).__lagProbe = { mark };
  console.info(
    `[lag-probe] on. Log: ${config.logDir}/lag-probe.jsonl. ` +
      'Felt a lag? __lagProbe.mark("what happened") or ⌘⌥⇧L saves a recording.'
  );
}
