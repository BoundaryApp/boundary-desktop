import fs from 'node:fs';
import path from 'node:path';

const SOUL_EXCERPT_MAX = 280;

export function resolveSoulFilePath(dataRoot: string, slug: string): string {
  return path.join(dataRoot, 'hermes', 'profiles', slug, 'SOUL.md');
}

export function excerptSoul(soul: string, max = SOUL_EXCERPT_MAX): string {
  const lines = soul.replace(/\r\n/g, '\n').split('\n');
  const body: string[] = [];
  let skippedTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!skippedTitle && /^#\s+/.test(trimmed)) {
      skippedTitle = true;
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      if (body.length) break;
      continue;
    }
    if (!trimmed) {
      if (body.length) break;
      continue;
    }
    body.push(trimmed);
  }
  const text = body.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  const clipped = text.slice(0, max).replace(/\s+\S*$/, '').trim();
  return `${clipped || text.slice(0, max).trim()}…`;
}

export function readSoulFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A soul with a new name and role (ADR 0010 §4), or null when it isn't the one Boundary
 * wrote: its first line must still be `# Name` and the old role must still be lines of their
 * own. Only those two parts change, so anything else in the file stays.
 */
export function rewriteSoulIdentity(
  soul: string,
  from: { displayName: string; role: string },
  to: { displayName: string; role: string }
): string | null {
  const text = soul.replace(/\r\n/g, '\n');
  const firstLine = text.split('\n', 1)[0] ?? '';
  const role = from.role.trim();
  if (firstLine.trim() !== `# ${from.displayName.trim()}` || !role) return null;
  const body = `${text.slice(firstLine.length)}\n`;
  const at = body.indexOf(`\n${role}\n`);
  if (at < 0) return null;
  const rest = body.slice(at + 1 + role.length, -1);
  return `# ${to.displayName.trim()}${body.slice(0, at + 1)}${to.role.trim()}${rest}`;
}
