import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWritingVoiceStyle,
  parseWritingVoiceStyle,
  replaceNeverDoes,
  splitFrontmatter,
  writeNeverDoes,
} from '../writingVoiceStyle';
import { writingVoiceFiles } from '../writingVoicePaths';

const STYLE = `---
voice: field-notes
calibrated: 2026-11-11
sample_count: 7
word_count: 6880
exemplars:
  - samples/a.md
  - samples/b.md
---

# Voice: field-notes

Writes like someone thinking aloud on a long walk.
Concrete detail first.

## Sentence rhythm

- Mean sentence length: 14 words

## Never does

- Never opens with a question
- Never uses exclamation marks
- Never ends on a summary
- Never <...>

## Notes

Keep it warm.
`;

describe('splitFrontmatter', () => {
  it('splits LF and CRLF files at the same place, returning LF text', () => {
    const lf = '---\nexemplars: [a.md]\n---\n# Voice: Mine\nBody line\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(splitFrontmatter(crlf)).toEqual(splitFrontmatter(lf));
    expect(splitFrontmatter(lf)).toEqual({ front: 'exemplars: [a.md]', body: '# Voice: Mine\nBody line\n' });
  });

  it('accepts a file that ends right after the closing ---', () => {
    expect(splitFrontmatter('---\r\ncalibrated: 2026-11-11\r\n---')).toEqual({ front: 'calibrated: 2026-11-11', body: '' });
  });

  it('leaves text without frontmatter whole', () => {
    expect(splitFrontmatter('# Voice\r\n---\r\n')).toEqual({ front: '', body: '# Voice\n---\n' });
  });
});

describe('parseWritingVoiceStyle', () => {
  it('reads the description, Never does, exemplars and date', () => {
    const style = parseWritingVoiceStyle(STYLE);
    expect(style.description).toBe(
      'Writes like someone thinking aloud on a long walk. Concrete detail first.'
    );
    expect(style.neverDoes).toEqual([
      'Never opens with a question',
      'Never uses exclamation marks',
      'Never ends on a summary',
    ]);
    expect(style.exemplars).toEqual(['samples/a.md', 'samples/b.md']);
    expect(style.calibrated).toBe('2026-11-11');
    expect(style.chars).toBe(STYLE.length);
  });

  it('reads CRLF files and flow lists the same way', () => {
    const crlf = STYLE.replace('exemplars:\n  - samples/a.md\n  - samples/b.md', 'exemplars: [samples/a.md, "samples/b.md"]').replace(/\n/g, '\r\n');
    const style = parseWritingVoiceStyle(crlf);
    expect(style.exemplars).toEqual(['samples/a.md', 'samples/b.md']);
    expect(style.neverDoes).toHaveLength(3);
    expect(style.description).toContain('long walk');
  });
});

describe('checkWritingVoiceStyle', () => {
  let root: string;
  let voice: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-style-'));
    voice = path.join(root, 'voice', 'v');
    fs.mkdirSync(path.join(voice, 'samples'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (text: string) => fs.writeFileSync(path.join(voice, 'STYLE.md'), text);

  it('says when the file is missing', async () => {
    expect(await checkWritingVoiceStyle(writingVoiceFiles(root), 'voice/v')).toEqual({ ok: false, reason: 'missing' });
  });

  it('needs exemplars', async () => {
    write(STYLE.replace('  - samples/a.md\n  - samples/b.md\n', ''));
    expect(await checkWritingVoiceStyle(writingVoiceFiles(root), 'voice/v')).toEqual({ ok: false, reason: 'no-exemplars' });
  });

  it('refuses an exemplar that is missing or outside the voice folder', async () => {
    fs.writeFileSync(path.join(voice, 'samples', 'a.md'), 'a');
    write(STYLE);
    expect(await checkWritingVoiceStyle(writingVoiceFiles(root), 'voice/v')).toEqual({ ok: false, reason: 'exemplar-missing' });
    fs.writeFileSync(path.join(root, 'outside.md'), 'x');
    write(STYLE.replace('samples/b.md', '../../outside.md'));
    expect(await checkWritingVoiceStyle(writingVoiceFiles(root), 'voice/v')).toEqual({ ok: false, reason: 'exemplar-missing' });
  });

  it('refuses an exemplar that links outside the voice folder', async () => {
    fs.writeFileSync(path.join(voice, 'samples', 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'outside.md'), 'x');
    fs.symlinkSync(path.join(root, 'outside.md'), path.join(voice, 'samples', 'b.md'));
    write(STYLE);
    expect(await checkWritingVoiceStyle(writingVoiceFiles(root), 'voice/v')).toEqual({ ok: false, reason: 'exemplar-missing' });
  });

  it('is ok when every exemplar is a file in the folder', async () => {
    fs.writeFileSync(path.join(voice, 'samples', 'a.md'), 'a');
    fs.writeFileSync(path.join(voice, 'samples', 'b.md'), 'b');
    write(STYLE);
    const result = await checkWritingVoiceStyle(writingVoiceFiles(root), 'voice/v');
    expect(result.ok).toBe(true);
  });
});

describe('replaceNeverDoes', () => {
  it('swaps only that section and keeps what follows', () => {
    const next = replaceNeverDoes(STYLE, ['Never shouts', '  ', 'Never hedges ']);
    expect(next).toContain('## Never does\n\n- Never shouts\n- Never hedges\n\n## Notes\n\nKeep it warm.\n');
    expect(next).not.toContain('Never opens with a question');
    expect(next.slice(0, next.indexOf('## Never does'))).toBe(STYLE.slice(0, STYLE.indexOf('## Never does')));
  });

  it('adds the section before Notes, or at the end', () => {
    const noSection = STYLE.replace(/## Never does[\s\S]*?(?=## Notes)/, '');
    expect(replaceNeverDoes(noSection, ['Never shouts'])).toContain(
      '## Never does\n\n- Never shouts\n\n## Notes'
    );
    expect(replaceNeverDoes('# Voice: x\n\nText.\n', ['Never shouts'])).toBe(
      '# Voice: x\n\nText.\n\n## Never does\n\n- Never shouts\n'
    );
  });

  it('keeps CRLF line endings', () => {
    const next = replaceNeverDoes(STYLE.replace(/\n/g, '\r\n'), ['Never shouts']);
    expect(next).toContain('## Never does\r\n\r\n- Never shouts\r\n');
    expect(next).not.toMatch(/[^\r]\n/);
  });
});

describe('writeNeverDoes', () => {
  it('says to calibrate first when there is no style guide', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-nd-'));
    expect(await writeNeverDoes(writingVoiceFiles(dir), '', ['Never shouts'])).toEqual({
      success: false,
      error: 'This voice has no style guide yet. Calibrate it first.',
    });
    fs.writeFileSync(path.join(dir, 'STYLE.md'), STYLE);
    const result = await writeNeverDoes(writingVoiceFiles(dir), '', ['Never shouts']);
    expect(result).toMatchObject({ success: true, style: { neverDoes: ['Never shouts'] } });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
