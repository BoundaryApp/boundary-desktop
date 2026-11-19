import fs from 'node:fs';
import path from 'node:path';
import type {
  WritingVoiceCheckSummary,
  WritingVoiceSampleCheck,
  WritingVoiceSource,
} from '../../../../shared/types/writingVoices';

/** The types the stack's write-in-voice skill reads (`corpus-stats.py` TEXT_SUFFIXES). */
export const WRITING_VOICE_SAMPLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.rst', '.text'];
const WRITING_VOICE_MAX_SAMPLE_BYTES = 5 * 1024 * 1024;
const WRITING_VOICE_LONG_PIECE_WORDS = 500;
const WRITING_VOICE_ENOUGH_LONG_PIECES = 5;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const FENCE_RE = /^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm;
const HEADER_RE = /^ {0,3}#{1,6}\s/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Word count without frontmatter or fenced code, and whether headers and lists are most lines. */
export function measureSampleText(text: string): { words: number; listHeavy: boolean } {
  const body = text.replace(/\r\n/g, '\n').replace(FRONTMATTER_RE, '').replace(FENCE_RE, '');
  const words = body.split(/\s+/).filter(Boolean).length;
  const lines = body.split('\n').filter((line) => line.trim());
  const structure = lines.filter((line) => HEADER_RE.test(line) || LIST_RE.test(line)).length;
  return { words, listHeavy: lines.length > 0 && structure * 2 > lines.length };
}

async function checkFile(
  filePath: string,
  source: WritingVoiceSource
): Promise<WritingVoiceSampleCheck> {
  const label = path.basename(filePath);
  const refuse = (refused: WritingVoiceSampleCheck['refused'], extension?: string) => ({
    label,
    source,
    words: 0,
    listHeavy: false,
    refused,
    ...(extension ? { extension } : {}),
  });
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return refuse('unreadable');
  }
  if (stat.isDirectory()) return refuse('folder');
  // A FIFO, socket or device named like a text file would block readFile; only plain files are samples.
  if (!stat.isFile()) return refuse('unreadable');
  const ext = path.extname(filePath).toLowerCase();
  if (!WRITING_VOICE_SAMPLE_EXTENSIONS.includes(ext)) {
    return refuse('type', ext ? ext.slice(1).toUpperCase() : undefined);
  }
  if (stat.size > WRITING_VOICE_MAX_SAMPLE_BYTES) return refuse('too-large');
  let text: string;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return refuse('unreadable');
  }
  const measured = measureSampleText(text);
  if (measured.words === 0) return refuse('empty');
  return { label, source, ...measured, refused: null };
}

/** The create sheet's check: each source with its counts or the reason it isn't used. */
export async function checkWritingVoiceSamples(
  sources: WritingVoiceSource[]
): Promise<WritingVoiceCheckSummary> {
  const seen = new Set<string>();
  const files: WritingVoiceSampleCheck[] = [];
  let pasted = 0;
  for (const source of sources) {
    if (source.kind === 'pasted') {
      pasted += 1;
      const measured = measureSampleText(source.text);
      files.push({
        label: `Pasted text ${pasted}`,
        source,
        ...measured,
        refused: measured.words === 0 ? 'empty' : null,
      });
      continue;
    }
    const resolved = path.resolve(source.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    files.push(await checkFile(resolved, source));
  }
  const used = files.filter((f) => f.refused === null);
  const longPieces = used.filter((f) => f.words >= WRITING_VOICE_LONG_PIECE_WORDS).length;
  return {
    files,
    pieces: used.length,
    words: used.reduce((sum, f) => sum + f.words, 0),
    longPieces,
    listHeavy: used.filter((f) => f.listHeavy).length,
    enough: longPieces >= WRITING_VOICE_ENOUGH_LONG_PIECES,
  };
}
