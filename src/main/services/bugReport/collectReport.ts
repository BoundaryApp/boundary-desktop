import type { ReportContext, ReportEnvironment, ReportError, ReportRedaction } from '../../../shared/bugReport';
import { redactReportText, type ReportIdentity } from './redactReport';

/** Recent errors go back this far (spec: Report contents). */
const REPORT_ERROR_WINDOW_MS = 10 * 60_000;
const MAX_ERRORS = 20;
const MAX_FRAMES = 5;
const MAX_MESSAGE = 500;

const ERROR_WORDS = /\b(?:error|errors|fail|failed|fails|failure|threw|throws|exception|crash|crashed|rejected|refused|timed out|timeout)\b/i;

/**
 * Reduce a stack frame's path to repo-relative form: `src/...` for source, the built file
 * for bundled code, and the file name for anything else. Redaction still runs afterwards.
 */
export function normaliseFrame(frame: string): string {
  const text = frame.trim().replace(/^at\s+/, '');
  return text.replace(/(?<=^|[\s(])(?:file:\/\/)?(\/[^\s():]+|[A-Za-z]:\\[^\s():]+)(?=(?::\d+){0,2}\)?$)/, (path) => {
    const unix = path.replace(/^file:\/\//, '').replace(/\\/g, '/');
    for (const marker of ['/src/', '/.vite/', '/node_modules/']) {
      const at = unix.lastIndexOf(marker);
      if (at >= 0) return unix.slice(at + 1);
    }
    return unix.slice(unix.lastIndexOf('/') + 1);
  });
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/**
 * The fields a report may carry from one debug-log line, or null when the line isn't an error.
 * Only time, area, message, error name and stack frames are read; everything else in `data`
 * (stdout, stderr, arguments, payloads) is dropped, because it can echo anything.
 */
export function errorFromLogLine(line: string): ReportError | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const time = str(record.ts);
  const area = str(record.area);
  const message = str(record.message);
  if (!time || !area || !message || area === 'session') return null;
  const data = (record.data && typeof record.data === 'object' ? record.data : {}) as Record<string, unknown>;
  const name = str(data.name) ?? str(data.errorName);
  const stack = str(data.stack);
  const errorMessage = str(data.message);
  if (!name && !stack && !ERROR_WORDS.test(message)) return null;
  const frames = (stack ?? '')
    .split('\n')
    .map((frameLine) => frameLine.trim())
    .filter((frameLine) => frameLine.startsWith('at '))
    .slice(0, MAX_FRAMES)
    .map(normaliseFrame);
  const text = errorMessage && errorMessage !== message ? `${message}: ${errorMessage}` : message;
  return {
    time,
    area,
    message: text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text,
    ...(name ? { name } : {}),
    frames,
  };
}

/** Errors logged in the window before `now`, newest last, at most 20. */
export function recentErrors(contents: string, now: number, windowMs = REPORT_ERROR_WINDOW_MS): ReportError[] {
  const errors: ReportError[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    const error = errorFromLogLine(line);
    if (!error) continue;
    const at = Date.parse(error.time);
    if (Number.isNaN(at) || at < now - windowMs || at > now + 60_000) continue;
    errors.push(error);
  }
  return errors.slice(-MAX_ERRORS);
}

function redactError(error: ReportError, identity: ReportIdentity, removed: ReportRedaction[]): ReportError {
  const clean = (text: string) => redactReportText(text, identity, removed).text;
  return {
    ...error,
    area: clean(error.area),
    message: clean(error.message),
    ...(error.name ? { name: clean(error.name) } : {}),
    frames: error.frames.map(clean),
  };
}

export interface CollectReportDeps {
  /** The debug log's last part (`readDebugLogTail`). */
  readLog: () => string;
  environment: () => ReportEnvironment;
  identity: () => ReportIdentity;
  now?: () => number;
}

/**
 * What a report starts from: app details and redacted recent errors. Reads the debug log only,
 * never session content (spec decisions 4 and 5).
 */
export function collectReportContext(deps: CollectReportDeps): ReportContext {
  const now = deps.now?.() ?? Date.now();
  const identity = deps.identity();
  const removed: ReportRedaction[] = [];
  const errors = recentErrors(deps.readLog(), now).map((error) => redactError(error, identity, removed));
  return { environment: deps.environment(), errors, redactions: removed };
}
