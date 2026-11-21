import path from 'node:path';
import type { WritingVoiceStyle } from '../../../../shared/types/writingVoices';
import type { StackFiles } from '../../stackHost/types';

/**
 * STYLE.md as the stack's write-in-voice skill writes it (templates/STYLE.md): YAML
 * frontmatter with `exemplars` and `calibrated`, a "# Voice:" title and paragraph, then
 * sections including "## Never does". Read without a YAML library: only these keys matter.
 */

const STYLE_FILE = 'STYLE.md';
const NEVER_HEADING_RE = /^##\s+Never does\b[^\n]*$/im;
const PLACEHOLDER_RE = /<[^>]*>/;

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * YAML frontmatter and the text after it, both with LF line endings. Every reader of STYLE.md
 * and of samples splits here, so the prompt, Settings and the sample count agree on where the
 * body starts.
 */
export function splitFrontmatter(text: string): { front: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  return match ? { front: match[1], body: normalized.slice(match[0].length) } : { front: '', body: normalized };
}

function readExemplars(front: string): string[] {
  const flow = /^exemplars:\s*\[(.*)\]\s*$/m.exec(front);
  if (flow) return flow[1].split(',').map(unquote).filter(Boolean);
  const block = /^exemplars:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(front);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, ''))
    .map(unquote)
    .filter(Boolean);
}

function readDescription(body: string): string {
  const lines = body.split('\n');
  const title = lines.findIndex((line) => /^#\s+/.test(line));
  const paragraph: string[] = [];
  for (const line of lines.slice(title + 1)) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) break;
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  return paragraph.join(' ');
}

function neverSection(body: string): { start: number; end: number } | null {
  const heading = NEVER_HEADING_RE.exec(body);
  if (!heading) return null;
  const after = heading.index + heading[0].length;
  const next = /^##\s/m.exec(body.slice(after));
  return { start: heading.index, end: next ? after + next.index : body.length };
}

export function parseWritingVoiceStyle(text: string): WritingVoiceStyle {
  const { front, body } = splitFrontmatter(text);
  const section = neverSection(body);
  const neverDoes = section
    ? body
        .slice(section.start, section.end)
        .split('\n')
        .slice(1)
        .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? '')
        .filter((line) => line && !PLACEHOLDER_RE.test(line))
    : [];
  const calibrated = /^calibrated:\s*(.+)$/m.exec(front);
  return {
    description: readDescription(body),
    neverDoes,
    exemplars: readExemplars(front),
    chars: text.length,
    calibrated: calibrated ? unquote(calibrated[1]) : null,
  };
}

export async function readWritingVoiceStyle(files: StackFiles, voiceRel: string): Promise<WritingVoiceStyle | null> {
  try {
    const text = await files.readText('userContent', path.posix.join(voiceRel, STYLE_FILE));
    return text === null ? null : parseWritingVoiceStyle(text);
  } catch {
    return null;
  }
}

async function isFileInside(files: StackFiles, voiceRel: string, relative: string): Promise<boolean> {
  try {
    const root = await files.realpath('userContent', voiceRel);
    const target = await files.realpath('userContent', path.posix.join(voiceRel, relative));
    if (root === null || target === null) return false;
    if (root ? !target.startsWith(`${root}/`) : !target) return false;
    return (await files.stat('userContent', target))?.kind === 'file';
  } catch {
    return false;
  }
}

/** Calibration's own check (ADR 0056 §4): STYLE.md exists and each exemplar is a file in the folder. */
export async function checkWritingVoiceStyle(
  files: StackFiles,
  voiceRel: string
): Promise<
  | { ok: true; style: WritingVoiceStyle }
  | { ok: false; reason: 'missing' | 'no-exemplars' | 'exemplar-missing' }
> {
  const style = await readWritingVoiceStyle(files, voiceRel);
  if (!style) return { ok: false, reason: 'missing' };
  if (style.exemplars.length === 0) return { ok: false, reason: 'no-exemplars' };
  for (const exemplar of style.exemplars) {
    if (!(await isFileInside(files, voiceRel, exemplar))) return { ok: false, reason: 'exemplar-missing' };
  }
  return { ok: true, style };
}

/** STYLE.md with its Never does bullets replaced; everything else is left as it was. */
export function replaceNeverDoes(text: string, lines: string[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  const bullets = lines
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');
  const block = `## Never does\n\n${bullets}\n`;
  const { body } = splitFrontmatter(normalized);
  const head = normalized.slice(0, normalized.length - body.length);
  const section = neverSection(body);
  let next: string;
  if (section) {
    const followed = section.end < body.length;
    next = body.slice(0, section.start) + block + (followed ? '\n' : '') + body.slice(section.end);
  } else {
    const notes = /^##\s+Notes\b/m.exec(body);
    if (notes) {
      next = `${body.slice(0, notes.index)}${block}\n${body.slice(notes.index)}`;
    } else {
      next = `${body.endsWith('\n') ? body : `${body}\n`}\n${block}`;
    }
  }
  return (head + next).replace(/\n/g, eol);
}

export async function writeNeverDoes(
  files: StackFiles,
  voiceRel: string,
  lines: string[]
): Promise<{ success: true; style: WritingVoiceStyle } | { success: false; error: string }> {
  const file = path.posix.join(voiceRel, STYLE_FILE);
  const text = await files.readText('userContent', file).catch((): null => null);
  if (text === null) {
    return { success: false, error: 'This voice has no style guide yet. Calibrate it first.' };
  }
  const next = replaceNeverDoes(text, lines);
  await files.writeText('userContent', file, next);
  return { success: true, style: parseWritingVoiceStyle(next) };
}
