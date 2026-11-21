import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkWritingVoiceSamples,
  measureSampleText,
} from '../writingVoiceSamples';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('measureSampleText', () => {
  it('leaves out frontmatter and fenced code when counting words', () => {
    const text = '---\ntitle: x\n---\none two\n```\ncode here\n```\nthree';
    expect(measureSampleText(text).words).toBe(3);
    expect(measureSampleText(text.replace(/\n/g, '\r\n')).words).toBe(3);
  });

  it('calls a file list-heavy when headers and list lines are more than half', () => {
    expect(measureSampleText('# A\n- b\n- c\nprose line here').listHeavy).toBe(true);
    expect(measureSampleText('# A\nprose\nprose\n- b').listHeavy).toBe(false);
  });

  it('counts numbered lines and indented headers as structure', () => {
    expect(measureSampleText('1. a\n2) b\n   ## h\nprose').listHeavy).toBe(true);
  });
});

describe('checkWritingVoiceSamples', () => {
  let dir: string;
  const file = (name: string, body: string | Buffer) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-samples-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('checks each source in order and gives a reason for each one refused', async () => {
    const a = file('a.md', words(600));
    const b = file('b.TXT', words(120));
    const c = file('c.pdf', 'pdf');
    const d = file('d.md', '  \n');
    const e = path.join(dir, 'e.md');
    fs.mkdirSync(e);
    const f = file('f.md', Buffer.alloc(6 * 1024 * 1024, 'a'));

    const summary = await checkWritingVoiceSamples([
      { kind: 'file', path: a },
      { kind: 'file', path: b },
      { kind: 'file', path: c },
      { kind: 'file', path: d },
      { kind: 'file', path: e },
      { kind: 'file', path: f },
      { kind: 'pasted', text: words(40) },
    ]);

    expect(summary.files.map((x) => [x.label, x.refused])).toEqual([
      ['a.md', null],
      ['b.TXT', null],
      ['c.pdf', 'type'],
      ['d.md', 'empty'],
      ['e.md', 'folder'],
      ['f.md', 'too-large'],
      ['Pasted text 1', null],
    ]);
    expect(summary.files[2].extension).toBe('PDF');
    expect(summary.pieces).toBe(3);
    expect(summary.words).toBe(760);
    expect(summary.longPieces).toBe(1);
    expect(summary.enough).toBe(false);
  });

  it('refuses a missing file without throwing', async () => {
    const summary = await checkWritingVoiceSamples([
      { kind: 'file', path: path.join(dir, 'gone.md') },
    ]);
    expect(summary.files[0].refused).toBe('unreadable');
    expect(summary.pieces).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO named like a text file without reading it', async () => {
    const fifo = path.join(dir, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
    const summary = await checkWritingVoiceSamples([{ kind: 'file', path: fifo }]);
    expect(summary.files[0].refused).toBe('unreadable');
    expect(summary.pieces).toBe(0);
  });

  it('lists the same file once', async () => {
    const a = file('a.md', words(10));
    const summary = await checkWritingVoiceSamples([
      { kind: 'file', path: a },
      { kind: 'file', path: path.join(dir, '.', 'a.md') },
    ]);
    expect(summary.files).toHaveLength(1);
    expect(summary.words).toBe(10);
  });

  it('is enough with five pieces of 500 words', async () => {
    const sources = [1, 2, 3, 4, 5].map((n) => ({
      kind: 'file' as const,
      path: file(`p${n}.md`, words(500)),
    }));
    const summary = await checkWritingVoiceSamples(sources);
    expect(summary.longPieces).toBe(5);
    expect(summary.enough).toBe(true);
  });

  it('counts list-heavy pieces', async () => {
    const summary = await checkWritingVoiceSamples([
      { kind: 'pasted', text: '# h\n- a\n- b\nprose' },
      { kind: 'pasted', text: words(30) },
    ]);
    expect(summary.listHeavy).toBe(1);
    expect(summary.files[1].label).toBe('Pasted text 2');
  });
});
