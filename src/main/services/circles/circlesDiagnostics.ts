import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { getDebugLogPath } from '../../persistDebugLog';

/**
 * Circles diagnostics: one JSON object per line, for reading a test run between two Macs after
 * the fact. Main writes it; the network process sends its events here (`diag` messages).
 *
 * Metadata only. No prompt or reply text, no names, no invite codes, no keys. People, devices
 * and Circles appear as the first 8 hex characters of their keys, which match across both
 * Macs' files. Peer addresses appear as a class (loopback, lan, cgnat, public), never the IP.
 *
 * Lives beside the debug log: ~/Library/Logs/Boundary/circles-diagnostics.log, with the run
 * before the last rotation in `.1`.
 */

const FILE_NAME = 'circles-diagnostics.log';
const MAX_BYTES = 20 * 1024 * 1024;

const runId = `${Date.now().toString(36)}-${process.pid}`;
const runStart = performance.now();
let filePath: string | null = null;
let headerWritten = false;
let broken = false;

export function circlesDiagnosticsPath(): string {
  filePath ??= path.join(path.dirname(getDebugLogPath()), FILE_NAME);
  return filePath;
}

/** First 8 hex characters: enough to tell keys apart in a small Circle, short enough to read. */
export function short(key: string | null | undefined): string | null {
  return key ? key.slice(0, 8) : null;
}

function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No file yet.
  }
}

function write(record: Record<string, unknown>): void {
  if (broken) return;
  const file = circlesDiagnosticsPath();
  try {
    if (!headerWritten) {
      headerWritten = true;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded(file);
      write({
        ev: 'run.start',
        appVersion: safe(() => app.getVersion()),
        packaged: safe(() => app.isPackaged),
        electron: process.versions.electron,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        cpus: os.cpus().length,
        memGb: Math.round(os.totalmem() / 2 ** 30),
        tzOffsetMin: new Date().getTimezoneOffset(),
      });
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never break Circles; stop trying after the first failure.
    broken = true;
  }
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/**
 * Record one event. `src` says which process saw it; `ms` is milliseconds since this run of
 * Boundary started, for ordering within a file. `t` is wall-clock time for lining up two Macs.
 */
export function diag(event: string, data: Record<string, unknown> = {}, src: 'main' | 'net' = 'main', at?: number): void {
  write({
    t: new Date(at ?? Date.now()).toISOString(),
    ms: Math.round(performance.now() - runStart),
    run: runId,
    src,
    ev: event,
    ...data,
  });
}
