import { describe, expect, it } from 'vitest';
import { extractProse, sourceSpan } from '../prose';

function blockTexts(markdown: string) {
  return extractProse(markdown).blocks.map((block) => [block.kind, block.text]);
}

describe('extractProse', () => {
  it('splits paragraphs on blank lines and joins wrapped lines with a space', () => {
    expect(blockTexts('One line\nwraps here.\n\nSecond paragraph.')).toEqual([
      ['paragraph', 'One line wraps here.'],
      ['paragraph', 'Second paragraph.'],
    ]);
  });

  it('keeps headings and list items as their own blocks, with heading level', () => {
    const doc = extractProse('## Setup Guide\n- first item\n  continues\n* second item\n1. third');
    expect(doc.blocks.map((b) => [b.kind, b.text, b.level])).toEqual([
      ['heading', 'Setup Guide', 2],
      ['listItem', 'first item continues', undefined],
      ['listItem', 'second item', undefined],
      ['listItem', 'third', undefined],
    ]);
  });

  it('leaves out fenced code, block quotes, tables, HTML blocks and rules', () => {
    const markdown = [
      'Before.',
      '```ts',
      'const delve = 1;',
      '```',
      '> Quoted delve text.',
      '| a | b |',
      '| --- | --- |',
      '<div>delve</div>',
      '---',
      'After.',
    ].join('\n');
    expect(blockTexts(markdown)).toEqual([
      ['paragraph', 'Before.'],
      ['paragraph', 'After.'],
    ]);
  });

  it('drops inline code, URLs and emphasis markers but keeps link and image text', () => {
    expect(
      blockTexts('Run `delve()` on **bold** and _it_ via [the docs](https://x.test) ![alt](a.png) https://y.test now.')
    ).toEqual([['paragraph', 'Run  on bold and it via the docs alt  now.']]);
  });

  it('keeps underscores inside words and backslash-escaped characters', () => {
    expect(blockTexts('snake_case_name and \\*literal\\*')).toEqual([
      ['paragraph', 'snake_case_name and *literal*'],
    ]);
  });

  it('maps every plain-text span back to the exact source characters', () => {
    const markdown = 'Intro.\n\n- **Speed:** it is a [pivotal](https://x.test) moment\n  for us.';
    const doc = extractProse(markdown);
    const item = doc.blocks[1];
    for (const word of ['Speed', 'pivotal', 'moment', 'for us']) {
      const start = item.text.indexOf(word);
      const span = sourceSpan(item, start, start + word.length);
      expect(markdown.slice(span.start, span.end)).toBe(word);
    }
  });

  it('gives each block its raw source for the formatting rules', () => {
    const markdown = 'Text.\n\n- **Speed:** fast';
    const item = extractProse(markdown).blocks[1];
    expect(item.raw).toBe('- **Speed:** fast');
    expect(markdown.slice(item.sourceStart, item.sourceStart + item.raw.length)).toBe(item.raw);
  });

  it('handles CRLF line endings', () => {
    expect(blockTexts('One\r\ntwo.\r\n\r\nThree.')).toEqual([
      ['paragraph', 'One two.'],
      ['paragraph', 'Three.'],
    ]);
  });
});
