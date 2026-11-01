/**
 * Errors from the debug log, reduced to fields safe to hand to a model (ADR 0040 §5). `data` is
 * dropped apart from an error's name and code, because its `stdout`, `stderr` and `message` can
 * echo anything, chat text included.
 */

export interface RecentProblem {
  ts: string;
  area: string;
  message: string;
  errorName?: string;
  code?: string;
}

const MAX_MESSAGE_CHARS = 160;
const DEFAULT_LIMIT = 30;
const PROBLEM_WORDS = /fail|error|threw|exception|unresponsive|timed out|gone|could not|couldn't|refused/i;
/** Names and codes are identifiers. Anything else in those fields is text, and is dropped. */
const ERROR_NAME = /^[A-Za-z][\w.]{0,60}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;

function identifier(value: unknown, shape: RegExp): string | undefined {
  return typeof value === 'string' && shape.test(value) ? value : undefined;
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // The tail can start partway through a line.
    return null;
  }
}

/** Newest last. `scrub` runs over the free text that's kept. */
export function recentProblems(
  logText: string,
  scrub: (text: string) => string,
  limit = DEFAULT_LIMIT
): RecentProblem[] {
  const problems: RecentProblem[] = [];
  for (const line of logText.split('\n')) {
    const record = parseRecord(line);
    if (!record || typeof record.ts !== 'string' || typeof record.area !== 'string') continue;
    if (typeof record.message !== 'string') continue;
    const data = (record.data ?? {}) as Record<string, unknown>;
    const errorName = identifier(data.errorName, ERROR_NAME) ?? identifier(data.name, ERROR_NAME);
    if (!errorName && !PROBLEM_WORDS.test(record.message)) continue;
    const code = identifier(data.code, ERROR_CODE);
    problems.push({
      ts: record.ts,
      area: scrub(record.area),
      message: scrub(record.message).slice(0, MAX_MESSAGE_CHARS),
      ...(errorName ? { errorName } : {}),
      ...(code ? { code } : {}),
    });
  }
  return problems.slice(-limit);
}
