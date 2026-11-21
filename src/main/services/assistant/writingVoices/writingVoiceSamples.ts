import fs from 'node:fs';
import path from 'node:path';
import type {
  WritingVoiceCheckSummary,
  WritingVoiceSampleCheck,
  WritingVoiceSource,
} from '../../../../shared/types/writingVoices';
import type { StackFileStat, StackFiles } from '../../stackHost/types';
import { splitFrontmatter } from './writingVoiceStyle';
import { WRITING_VOICE_ENOUGH_LONG_PIECES, WRITING_VOICE_LONG_PIECE_WORDS } from '../../../../shared/writingVoiceLimits';

/** The types the stack's write-in-voice skill reads (`corpus-stats.py` TEXT_SUFFIXES). */
export const WRITING_VOICE_SAMPLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.rst', '.text'];
const WRITING_VOICE_MAX_SAMPLE_BYTES = 5 * 1024 * 1024;

const FENCE_RE = /^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm;
const HEADER_RE = /^ {0,3}#{1,6}\s/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Word count without frontmatter or fenced code, and whether headers and lists are most lines. */
export function measureSampleText(text: string): { words: number; listHeavy: boolean } {
  const body = splitFrontmatter(text).body.replace(FENCE_RE, '');
  const words = body.split(/\s+/).filter(Boolean).length;
  const lines = body.split('\n').filter((line) => line.trim());
  const structure = lines.filter((line) => HEADER_RE.test(line) || LIST_RE.test(line)).length;
  return { words, listHeavy: lines.length > 0 && structure * 2 > lines.length };
}

/** How a sample is looked at: on this machine, or in the stack's files. */
interface SampleReader {
  stat(): Promise<StackFileStat | null>;
  read(): Promise<string>;
}

async function checkSample(
  name: string,
  source: WritingVoiceSource,
  reader: SampleReader
): Promise<WritingVoiceSampleCheck> {
  const label = path.basename(name);
  const refuse = (refused: WritingVoiceSampleCheck['refused'], extension?: string) => ({
    label,
    source,
    words: 0,
    listHeavy: false,
    refused,
    ...(extension ? { extension } : {}),
  });
  let stat: StackFileStat | null;
  try {
    stat = await reader.stat();
  } catch {
    return refuse('unreadable');
  }
  if (!stat) return refuse('unreadable');
  if (stat.kind === 'folder') return refuse('folder');
  // A FIFO, socket or device named like a text file would block a read; only plain files are samples.
  if (stat.kind !== 'file') return refuse('unreadable');
  const ext = path.extname(name).toLowerCase();
  if (!WRITING_VOICE_SAMPLE_EXTENSIONS.includes(ext)) {
    return refuse('type', ext ? ext.slice(1).toUpperCase() : undefined);
  }
  if (stat.size > WRITING_VOICE_MAX_SAMPLE_BYTES) return refuse('too-large');
  let text: string;
  try {
    text = await reader.read();
  } catch {
    return refuse('unreadable');
  }
  const measured = measureSampleText(text);
  if (measured.words === 0) return refuse('empty');
  return { label, source, ...measured, refused: null };
}

/** A file a person picked on this machine. */
function localReader(filePath: string): SampleReader {
  return {
    async stat() {
      const st = await fs.promises.stat(filePath);
      return { kind: st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'other', size: st.size };
    },
    read: () => fs.promises.readFile(filePath, 'utf8'),
  };
}

/** The bytes of a sample a person picked on this machine, to copy into the stack. */
export function readLocalSample(filePath: string): Promise<Uint8Array> {
  return fs.promises.readFile(filePath);
}

function summarize(files: WritingVoiceSampleCheck[]): WritingVoiceCheckSummary {
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

/** The same check over a voice's saved samples, `names` relative to `samplesRel` in user content. */
export async function checkStackSamples(
  files: StackFiles,
  samplesRel: string,
  names: string[]
): Promise<WritingVoiceCheckSummary> {
  const checks: WritingVoiceSampleCheck[] = [];
  for (const name of names) {
    const rel = path.posix.join(samplesRel, name);
    checks.push(
      await checkSample(name, { kind: 'file', path: rel }, {
        stat: () => files.stat('userContent', rel),
        read: async () => {
          const text = await files.readText('userContent', rel);
          if (text === null) throw new Error('Sample is gone');
          return text;
        },
      })
    );
  }
  return summarize(checks);
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
    files.push(await checkSample(resolved, source, localReader(resolved)));
  }
  return summarize(files);
}
