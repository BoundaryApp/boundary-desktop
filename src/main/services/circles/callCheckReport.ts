/**
 * The call check report: one JSON file per Mac with everything a two-Mac run needs read after
 * the fact. It holds this Mac's environment, the sheet's results, the tester's network label,
 * and every Circles diagnostics event from this launch of the app (call results and samples,
 * tunnel samples, DHT and peer events, heartbeats). Diagnostics are metadata only, so the file is
 * safe to share; the label is the only free text, and it never goes to the diagnostics log.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, shell, type WebContents } from 'electron';
import { APP_NAME } from '../../../shared/buildIdentity';
import { cleanCallCheckResult, type CallCheckResult } from '../../../shared/callCheck';
import { slugify } from '../../../shared/utils/slug';
import { pickSavePath } from '../../host/windows';
import { circlesDiagnosticsPath, diagnosticsRunId } from './circlesDiagnostics';

export const REPORT_FORMAT = 'boundary-call-check/1';
const MAX_LABEL = 60;
const MAX_RESULTS = 2_000;

export interface CallCheckEnvironment {
  app: string;
  appVersion: string | null;
  electron: string;
  chrome: string;
  os: string;
  osRelease: string;
  arch: string;
  model: string | null;
  cpu: string | null;
  cores: number;
  memGb: number;
}

export interface CallCheckReport {
  format: typeof REPORT_FORMAT;
  exportedAt: string;
  label: string;
  diagnosticsRun: string;
  environment: CallCheckEnvironment;
  results: CallCheckResult[];
  /** This launch's diagnostics events, oldest first. */
  events: Record<string, unknown>[];
}

/** A network label as the tester typed it: one line, printable, at most 60 characters. */
export function cleanLabel(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL);
}

/** Events from diagnostics files' text that belong to one launch, in file order. */
export function eventsForRun(texts: string[], run: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.includes(run)) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.run === run) events.push(event);
      } catch {
        // A line cut off by a crash.
      }
    }
  }
  return events;
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function callCheckEnvironment(): CallCheckEnvironment {
  return {
    app: APP_NAME,
    appVersion: safe(() => app.getVersion()),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    os: safe(() => process.getSystemVersion()) ?? '',
    osRelease: os.release(),
    arch: process.arch,
    model:
      process.platform === 'darwin'
        ? safe(() => execFileSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2_000 }).trim())
        : null,
    cpu: os.cpus()[0]?.model ?? null,
    cores: os.cpus().length,
    memGb: Math.round(os.totalmem() / 2 ** 30),
  };
}

export function buildCallCheckReport(input: {
  label: unknown;
  results: unknown;
  environment: CallCheckEnvironment;
  diagnostics: string[];
  run: string;
  now?: Date;
}): CallCheckReport {
  const results = (Array.isArray(input.results) ? input.results.slice(0, MAX_RESULTS) : [])
    .map((result) => cleanCallCheckResult(result))
    .filter((result): result is CallCheckResult => result !== null);
  return {
    format: REPORT_FORMAT,
    exportedAt: (input.now ?? new Date()).toISOString(),
    label: cleanLabel(input.label),
    diagnosticsRun: input.run,
    environment: input.environment,
    results,
    events: eventsForRun(input.diagnostics, input.run),
  };
}

/** A file name from the label and the time, such as `call-check-home-wifi-20261106-1530.json`. */
export function reportFileName(label: string, now = new Date()): string {
  const slug = slugify(label, { max: 40 });
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `call-check-${slug || 'mac'}-${stamp}.json`;
}

function readDiagnostics(): string[] {
  const file = circlesDiagnosticsPath();
  return [`${file}.1`, file].map((name) => safe(() => fs.readFileSync(name, 'utf8')) ?? '');
}

/** Ask where to save the report, write it and show it in Finder. */
export async function exportCallCheckReport(
  sender: WebContents,
  input: { label?: unknown; results?: unknown }
): Promise<{ success: true; path: string } | { success: false; canceled?: boolean; error?: string }> {
  const report = buildCallCheckReport({
    label: input.label,
    results: input.results,
    environment: callCheckEnvironment(),
    diagnostics: readDiagnostics(),
    run: diagnosticsRunId(),
  });
  const options = {
    title: 'Save call check report',
    defaultPath: path.join(app.getPath('desktop'), reportFileName(report.label)),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const picked = await pickSavePath(sender, options);
  if (!picked) return { success: false, canceled: true };
  try {
    fs.writeFileSync(picked, `${JSON.stringify(report, null, 1)}\n`, 'utf8');
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  shell.showItemInFolder(picked);
  return { success: true, path: picked };
}
