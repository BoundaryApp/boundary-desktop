import fs from 'node:fs';
import type { StackFiles, StackLocation } from '../stackHost/types';

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

/**
 * Keys the stack's `.env.example` gave a trailing ` # comment` before v0.3.17. Compose drops the
 * comment, but the stack's `env_get` keeps it, so its host scripts (n8n credential sync, corpus)
 * read `NEO4J_USERNAME` as `neo4j   # …`. Its `upgrades/v0.3.17.sh` removes them, and Boundary
 * doesn't run upgrade hooks on a stack it manages.
 */
export const STACK_INLINE_COMMENT_KEYS = [
  'LLM_BINDING_API_KEY',
  'NEO4J_URI',
  'NEO4J_USERNAME',
  'NEO4J_PASSWORD',
  'GPTR_MCP_URL',
] as const;

/**
 * Drop an unquoted trailing comment from the lines that set any of the keys, as the stack's
 * v0.3.17 hook does: the comment starts at the first whitespace before a `#`, and a value that
 * would be left empty, or a quoted one, is kept as it is. Other lines stay byte-for-byte.
 */
export function stripInlineEnvComments(contents: string, keys: readonly string[]): string {
  const strip = new Set(keys);
  return splitLines(contents)
    .map((line) => {
      const key = lineKey(line);
      if (key === undefined || !strip.has(key) || !line.startsWith(`${key}=`)) return line;
      const ending = /\r?\n$/.exec(line)?.[0] ?? '';
      const value = line.slice(key.length + 1, line.length - ending.length);
      if (value.startsWith('"') || value.startsWith("'")) return line;
      const comment = /\s#/.exec(value);
      if (!comment) return line;
      const kept = value.slice(0, comment.index).trimEnd();
      return kept ? `${key}=${kept}${ending}` : line;
    })
    .join('');
}

/** Parse a dotenv file in the stack; `{}` when it is missing or unreadable. */
export async function readStackEnv(
  files: StackFiles,
  location: StackLocation,
  relPath: string
): Promise<Record<string, string>> {
  try {
    return parseEnv((await files.readText(location, relPath)) ?? '');
  } catch {
    return {};
  }
}

/**
 * Set keys in a dotenv file in the stack, creating the file and its folder when missing. The
 * file is replaced in one step, and not written when nothing changes. Returns whether it was.
 */
export async function writeStackEnvValues(
  files: StackFiles,
  location: StackLocation,
  relPath: string,
  values: Record<string, string>
): Promise<boolean> {
  const contents = await files.readText(location, relPath);
  const next = upsertEnvLines(contents ?? '', values);
  if (contents !== null && next === contents) return false;
  await files.writeText(location, relPath, next);
  return true;
}
