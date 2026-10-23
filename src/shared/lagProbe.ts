/**
 * Lag probe: dev-time instrumentation for UI stalls (typing and scrolling lag in chat).
 * The renderer reports what it measures to main, which writes one JSONL log and keeps
 * flight recorders (a Chrome trace and a main-process CPU profile) that are saved to disk
 * only around a stall.
 *
 * On by default in unpackaged builds. BOUNDARY_LAG_PROBE=0 turns it off, =1 turns it on in
 * a packaged build. BOUNDARY_LAG_TRACE=0 keeps the log but turns the recorders off.
 */

export const LAG_PROBE_CHANNELS = {
  config: 'lag-probe:config',
  report: 'lag-probe:report',
  mark: 'lag-probe:mark',
} as const;

export interface LagProbeConfig {
  enabled: boolean;
  tracing: boolean;
  logDir: string | null;
}

/** One renderer measurement. `kind` names it; the rest is kind-specific and logged as-is. */
export interface LagProbeReport {
  kind: string;
  /** Epoch ms when the measured thing started. */
  at: number;
  /** How long it took, for kinds that are durations. */
  ms?: number;
  /** Ask main to save the flight recorders around this one. */
  severe?: boolean;
  [key: string]: unknown;
}

/** Below these, nothing is logged (ms). */
export const LAG_THRESHOLDS = {
  /** Keystroke/click to next paint (Event Timing duration). */
  event: 50,
  /** Long animation frame duration. */
  frame: 100,
  /** Gap between animation frames while typing or scrolling. */
  frameGap: 100,
  /** One React commit. */
  reactCommit: 16,
  /** Main process event loop blocked. */
  mainStall: 50,
  /** Synchronous part of one IPC handler in main. */
  ipcSync: 16,
  /** Anything this slow saves the flight recorders. */
  severe: 200,
} as const;
