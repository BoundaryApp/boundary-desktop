/**
 * Markdown → prose blocks for the writing check (writing check spec, phase 1).
 *
 * A line scanner, not a CommonMark parser. It keeps paragraphs, headings and list items, and
 * leaves out what isn't the author's prose: fenced code, block quotes, tables, HTML blocks,
 * inline code and URLs. Every character of a block's text maps back to its source offset, so
 * a flag can point at the exact characters the user wrote.
 */

type BlockKind = 'paragraph' | 'heading' | 'listItem';

export interface ProseBlock {
  kind: BlockKind;
  /** 1–6 for headings. */
  level?: number;
  /** Plain text: markers, code and URLs removed, wrapped lines joined with a space. */
  text: string;
  /** Source offset of each character of `text`. */
  map: number[];
  /** The block's lines as written, markers included. */
  raw: string;
  sourceStart: number;
}

interface ProseDoc {
  blocks: ProseBlock[];
}

interface Line {
  text: string;
  start: number;
}

interface Piece {
  text: string;
  offset: number;
}

interface Pending {
  kind: BlockKind;
  level?: number;
  pieces: Piece[];
  rawStart: number;
  rawEnd: number;
}

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(\s{0,3}(#{1,6})\s+)(.*?)(\s+#+)?\s*$/;
const LIST = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)/;
const SKIPPED = [
  /^\s{0,3}>/, // block quote: someone else's words
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, // thematic break
  /^\s*\|/, // table row
  /^\s{0,3}<[A-Za-z/!]/, // HTML block
];
const URL_AT = /^https?:\/\/[^\s<>]+/;
const ANGLE_AT = /^<(?:https?:|mailto:|\/?[A-Za-z][^<>\n]*)>/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>|~]/;
const WORD = /\w/;

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(source)) !== null) {
    lines.push({ text: source.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), start });
  return lines;
}

/** Appends the plain characters of one line of inline markdown to `chars`/`map`. */
function scanInline(text: string, offset: number, chars: string[], map: number[]): void {
  const emit = (ch: string, at: number) => {
    chars.push(ch);
    map.push(offset + at);
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.test(text[i + 1])) {
      emit(text[i + 1], i + 1);
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`';
      const close = text.indexOf(run, i + run.length);
      if (close !== -1) {
        i = close + run.length;
        continue;
      }
      i += run.length;
      continue;
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const open = ch === '!' ? i + 1 : i;
      const closeBracket = text.indexOf(']', open + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          scanInline(text.slice(open + 1, closeBracket), offset + open + 1, chars, map);
          i = closeParen + 1;
          continue;
        }
      }
    }
    const angle = ch === '<' ? ANGLE_AT.exec(rest) : null;
    if (angle) {
      i += angle[0].length;
      continue;
    }
    const url = ch === 'h' && (i === 0 || !WORD.test(text[i - 1])) ? URL_AT.exec(rest) : null;
    if (url) {
      // Leave closing punctuation in the prose so the sentence still ends.
      i += url[0].replace(/[.,;:!?)]+$/, '').length;
      continue;
    }
    if (ch === '*' || ch === '~') {
      i += 1;
      continue;
    }
    if (ch === '_') {
      const inWord = i > 0 && WORD.test(text[i - 1]) && WORD.test(text[i + 1] ?? '');
      if (!inWord) {
        i += 1;
        continue;
      }
    }
    emit(ch, i);
    i += 1;
  }
}

function finish(pending: Pending, source: string): ProseBlock {
  const chars: string[] = [];
  const map: number[] = [];
  pending.pieces.forEach((piece, index) => {
    if (index > 0) {
      chars.push(' ');
      map.push(Math.max(piece.offset - 1, 0));
    }
    scanInline(piece.text, piece.offset, chars, map);
  });
  return {
    kind: pending.kind,
    ...(pending.level !== undefined ? { level: pending.level } : {}),
    text: chars.join(''),
    map,
    raw: source.slice(pending.rawStart, pending.rawEnd),
    sourceStart: pending.rawStart,
  };
}

export function extractProse(source: string): ProseDoc {
  const blocks: ProseBlock[] = [];
  let pending: Pending | null = null;
  let inFence = false;
  const flush = () => {
    if (pending && pending.pieces.length > 0) blocks.push(finish(pending, source));
    pending = null;
  };

  for (const line of splitLines(source)) {
    if (FENCE.test(line.text)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.text.trim() === '' || SKIPPED.some((pattern) => pattern.test(line.text))) {
      flush();
      continue;
    }
    const lineEnd = line.start + line.text.length;
    const heading = HEADING.exec(line.text);
    if (heading) {
      flush();
      blocks.push(
        finish(
          {
            kind: 'heading',
            level: heading[2].length,
            pieces: [{ text: heading[3], offset: line.start + heading[1].length }],
            rawStart: line.start,
            rawEnd: lineEnd,
          },
          source
        )
      );
      continue;
    }
    const marker = LIST.exec(line.text);
    if (marker) {
      flush();
      pending = {
        kind: 'listItem',
        pieces: [{ text: line.text.slice(marker[1].length), offset: line.start + marker[1].length }],
        rawStart: line.start,
        rawEnd: lineEnd,
      };
      continue;
    }
    const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
    const piece = { text: line.text.slice(indent).trimEnd(), offset: line.start + indent };
    if (pending) {
      (pending as Pending).pieces.push(piece);
      (pending as Pending).rawEnd = lineEnd;
    } else {
      pending = { kind: 'paragraph', pieces: [piece], rawStart: line.start, rawEnd: lineEnd };
    }
  }
  flush();
  return { blocks };
}

/** Source offsets for `text.slice(start, end)` of a block. */
export function sourceSpan(block: ProseBlock, start: number, end: number): { start: number; end: number } {
  return { start: block.map[start], end: block.map[end - 1] + 1 };
}
