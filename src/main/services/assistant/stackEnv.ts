import fs from 'node:fs';
import path from 'node:path';

/**
 * Read and edit dotenv files: the stack's `.env` and the Hermes profiles' `.env`. The
 * parser follows what compose and `source` read from the stack's `.env.example`: an
 * optional `export `, single or double quotes, and an unquoted value's trailing ` # …`
 * comment. A `#` with no whitespace before it is part of the value.
 */

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function parseValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    if (close > 0) return value.slice(1, close);
  }
  return raw.replace(/\s#.*$/, '').trim();
}

/** `KEY=value` pairs set in dotenv contents. A key set twice keeps its last value. */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line);
    if (match) out[match[1]] = parseValue(match[2]);
  }
  return out;
}

/** Parse a dotenv file; `{}` when it is missing or unreadable. */
export function readEnvFile(envPath: string): Record<string, string> {
  try {
    return parseEnv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

/** Split into lines that keep their own line ending, so untouched lines stay byte-for-byte. */
function splitLines(contents: string): string[] {
  return contents === '' ? [] : contents.split(/(?<=\n)/);
}

function lineKey(line: string): string | undefined {
  return ENV_LINE.exec(line.replace(/\r?\n$/, ''))?.[1];
}

/**
 * Set each key to its value. A line that already sets the key (with or without `export`)
 * is rewritten as `KEY=value`; missing keys are appended after the last non-blank line.
 * Values are written as given.
 */
export function upsertEnvLines(contents: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));
  const out = splitLines(contents).map((line) => {
    const key = lineKey(line);
    if (key === undefined || !Object.hasOwn(values, key)) return line;
    remaining.delete(key);
    const ending = /\r?\n$/.exec(line)?.[0] ?? '';
    return `${key}=${values[key]}${ending}`;
  });
  if (remaining.size === 0) return out.join('');
  // Appended keys go straight after the last non-blank line.
  const head = out.join('').replace(/\s*$/, '');
  const added = [...remaining].map(([key, value]) => `${key}=${value}\n`).join('');
  return head ? `${head}\n${added}` : added;
}

/** Drop the lines that set any of the keys (with or without `export`). */
export function removeEnvLines(contents: string, keys: readonly string[]): string {
  const drop = new Set(keys);
  return splitLines(contents)
    .filter((line) => {
      const key = lineKey(line);
      return key === undefined || !drop.has(key);
    })
    .join('');
}

/** Set keys in a dotenv file, creating the file and its folder when missing. */
export function writeEnvValues(envPath: string, values: Record<string, string>): void {
  const contents = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, upsertEnvLines(contents, values), 'utf8');
}
