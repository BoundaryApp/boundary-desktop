import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Append-only record of every host-bridge call and what happened to it (ADR 0027 §7). One JSON
 * object per line in `userData/host-bridge/audit.jsonl`. At 5 MB the file moves to
 * `audit.1.jsonl` (replacing the previous one) and a new file starts. Never throws.
 */

export type AuditDecision = 'granted' | 'allowed' | 'always' | 'denied' | 'timeout' | 'invalid' | 'error';

export interface AuditEntry {
  tool: string;
  decision: AuditDecision;
  /** Arguments as Boundary read them, already trimmed by the caller. */
  args: Record<string, unknown>;
  outcome?: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_STRING = 300;

export function getAuditLogPath(): string {
  return path.join(app.getPath('userData'), 'host-bridge', 'audit.jsonl');
}

/** Long strings are cut so the log can't become a copy of what the agent handled. */
export function trimForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] =
      typeof value === 'string' && value.length > MAX_STRING
        ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)`
        : value;
  }
  return out;
}

export function appendAudit(entry: AuditEntry, filePath = getAuditLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      if (fs.statSync(filePath).size > MAX_FILE_BYTES) {
        fs.renameSync(filePath, filePath.replace(/\.jsonl$/, '.1.jsonl'));
      }
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* auditing must never take down a tool call */
  }
}
