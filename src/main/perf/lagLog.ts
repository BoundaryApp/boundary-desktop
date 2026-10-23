/**
 * The lag probe's log (see src/shared/lagProbe.ts): one JSON object per line in
 * ~/Library/Logs/Boundary/lag-probe/lag-probe.jsonl. No side effects on import, so any
 * main-process code can add timings to it.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDebugLogPath } from '../persistDebugLog';

function envFlag(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return undefined;
}

const isTest = process.env.NODE_ENV === 'test' || process.env.ENVIRONMENT === 'test';
export const lagProbeEnabled = !isTest && (envFlag('BOUNDARY_LAG_PROBE') ?? !app.isPackaged);
export const lagProbeTracing = lagProbeEnabled && (envFlag('BOUNDARY_LAG_TRACE') ?? true);

export const lagLogDir = lagProbeEnabled
  ? path.join(path.dirname(getDebugLogPath()), 'lag-probe')
  : null;
export const lagTraceDir = lagLogDir ? path.join(lagLogDir, 'traces') : null;

const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const SESSION_LOG_CAP_BYTES = 50 * 1024 * 1024;

let stream: fs.WriteStream | null = null;
let written = 0;

function openLog(): void {
  if (!lagLogDir || stream) return;
  try {
    fs.mkdirSync(lagTraceDir!, { recursive: true });
    const file = path.join(lagLogDir, 'lag-probe.jsonl');
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
}

export function lagLog(entry: { kind: string; [key: string]: unknown }, force = false): void {
  if (!lagProbeEnabled) return;
  openLog();
  if (!stream || (written > SESSION_LOG_CAP_BYTES && !force)) return;
  let line: string;
  try {
    line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + '\n';
  } catch {
    return;
  }
  written += line.length;
  stream.write(line);
}


export function endLagLog(): void {
  stream?.end();
}

/** Milliseconds rounded to 0.1, for log fields. */
export function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}
