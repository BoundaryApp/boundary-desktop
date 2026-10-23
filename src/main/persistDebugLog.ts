import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;
const MAX_FIELD_CHARS = 8_000;

export const DEBUG_LOG_FILENAME = 'boundary-debug.log';

const sessionId = `${Date.now().toString(36)}-${process.pid}`;

let cachedPath: string | null = null;
let sessionHeaderWritten = false;

/**
 * Finder-reachable log for packaged-app debugging on another Mac.
 * macOS: ~/Library/Logs/Boundary/boundary-debug.log
 */
export function getDebugLogPath(): string {
  if (cachedPath) return cachedPath;
  if (process.env.NODE_ENV === 'test' || process.env.ENVIRONMENT === 'test') {
    cachedPath = path.join(os.tmpdir(), 'boundary-desktop-vitest-logs', DEBUG_LOG_FILENAME);
    return cachedPath;
  }
  if (process.platform === 'darwin') {
    cachedPath = path.join(os.homedir(), 'Library', 'Logs', 'Boundary', DEBUG_LOG_FILENAME);
    return cachedPath;
  }
  if (process.platform === 'win32') {
    cachedPath = path.join(
      os.homedir(),
      'AppData',
      'Roaming',
      'Boundary',
      'logs',
      DEBUG_LOG_FILENAME
    );
    return cachedPath;
  }
  cachedPath = path.join(os.homedir(), '.config', 'Boundary', 'logs', DEBUG_LOG_FILENAME);
  return cachedPath;
}

export function truncateForLog(value: unknown, max = MAX_FIELD_CHARS): string {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : stringifySafe(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

export function fileStatForLog(filePath: string): Record<string, unknown> {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mode: (stat.mode & 0o777).toString(8),
      uid: stat.uid,
      gid: stat.gid,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      executable: Boolean(stat.mode & 0o111),
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { exists: false, code: err.code, message: err.message };
  }
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error == null) return { type: 'null' };
  if (error instanceof Error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      signal?: string | null;
      killed?: boolean;
      status?: number | null;
    };
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      path: err.path,
      signal: err.signal ?? undefined,
      killed: err.killed,
      status: err.status ?? undefined,
      stdout: truncateForLog(err.stdout, 4000),
      stderr: truncateForLog(err.stderr, 4000),
      stack: truncateForLog(err.stack, 2500),
    };
  }
  return { message: truncateForLog(error, 2000) };
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_FILE_BYTES) return;
    const fd = fs.openSync(filePath, 'r');
    try {
      const start = Math.max(0, stat.size - KEEP_BYTES);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.writeFileSync(filePath, buf);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* first write or unreadable */
  }
}

function ensureSessionHeader(filePath: string): void {
  if (sessionHeaderWritten) return;
  sessionHeaderWritten = true;
  rotateIfNeeded(filePath);
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      sessionId,
      pid: process.pid,
      area: 'session',
      message: 'debug session start',
      data: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        execPath: process.execPath,
        cwd: process.cwd(),
        argv: process.argv,
        packagedHint: process.resourcesPath ?? null,
        ppid: process.ppid,
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
      },
    }) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * Append one JSONL event. Never throws.
 */
export function persistDebugLog(
  area: string,
  message: string,
  data: Record<string, unknown> = {}
): void {
  try {
    const filePath = getDebugLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    ensureSessionHeader(filePath);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        sessionId,
        pid: process.pid,
        area,
        message,
        data,
      }) + '\n';
    fs.appendFileSync(filePath, line, 'utf8');
  } catch {
    /* logging must never take down the app */
  }
}

export function readDebugLogTail(maxBytes = 256_000): { path: string; contents: string } {
  const filePath = getDebugLogPath();
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return { path: filePath, contents: buf.toString('utf8') };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return {
      path: filePath,
      contents: `Log not readable yet: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Test helper */
export function resetDebugLogPathCache(): void {
  cachedPath = null;
  sessionHeaderWritten = false;
}
