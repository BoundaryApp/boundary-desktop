import { describe, expect, it } from 'vitest';
import {
  escapeUnknownTags,
  markdownToPlainText,
  splitLeadingQuote,
  toBlockquote,
  withQuote,
} from '../../../../shared/markdownText';
import { projectRelativePath } from '../../../../shared/hermesToolPaths';

describe('markdownToPlainText', () => {
  it('drops markdown syntax and keeps the words', () => {
    const md = [
      '## Cover letter',
      '',
      'I **design** tools for _hiring_ teams, see [my site](https://ada.dev) and `resume.md`.',
      '',
      '- first point',
      '- [x] done item',
      '  * nested ~~old~~ point',
      '',
      '> Quoted *line*',
      '',
      '---',
      '',
      '| Tool | Use |',
      '| --- | :-: |',
      '| pandoc | export |',
    ].join('\n');
    expect(markdownToPlainText(md)).toBe(
      [
        'Cover letter',
        '',
        'I design tools for hiring teams, see my site (https://ada.dev) and resume.md.',
        '',
        '• first point',
        '• done item',
        '  • nested old point',
        '',
        'Quoted line',
        '',
        'Tool\tUse',
        'pandoc\texport',
      ].join('\n')
    );
  });

  it('keeps code block contents verbatim without the fences', () => {
    expect(markdownToPlainText('Run:\n\n```bash\npandoc a.md -o **a**.pdf\n```\n\nDone.')).toBe(
      'Run:\n\npandoc a.md -o **a**.pdf\n\nDone.'
    );
  });

  it('leaves underscores inside words and escaped characters alone', () => {
    expect(markdownToPlainText('Set snake_case_name and 2 \\* 3')).toBe(
      'Set snake_case_name and 2 * 3'
    );
  });

  it('keeps an image alt text and a bare autolink', () => {
    expect(markdownToPlainText('![Chart](c.png) at <https://x.dev>')).toBe(
      'Chart at https://x.dev'
    );
  });
});

describe('quotes', () => {
  it('turns text into a blockquote, keeping blank lines inside it', () => {
    expect(toBlockquote('first\n\nsecond\n')).toBe('> first\n>\n> second');
  });

  it('sends the quote above what was typed', () => {
    expect(withQuote('the product I want to build', 'Make this warmer.')).toBe(
      '> the product I want to build\n\nMake this warmer.'
    );
    expect(withQuote('just the quote', '  ')).toBe('> just the quote');
  });

  it('splits a sent quote back out of a prompt', () => {
    expect(splitLeadingQuote('> first\n>\n> second\n\nMake it warmer.')).toEqual({
      quote: 'first\n\nsecond',
      body: 'Make it warmer.',
    });
    expect(splitLeadingQuote('No quote here\n> later line')).toEqual({
      quote: null,
      body: 'No quote here\n> later line',
    });
    expect(splitLeadingQuote('>not a quote')).toEqual({ quote: null, body: '>not a quote' });
  });
});

describe('escapeUnknownTags', () => {
  it('shows invented tags literally so fake tool output is visible', () => {
    expect(
      escapeUnknownTags('<action>\nWrite file to /x/test.txt\n</action>\n<result>\nok\n</result>')
    ).toBe('\\<action>\nWrite file to /x/test.txt\n\\</action>\n\\<result>\nok\n\\</result>');
    expect(escapeUnknownTags('<tool_call name="write_file">')).toBe(
      '\\<tool_call name="write_file">'
    );
  });

  it('leaves tags the renderer keeps, autolinks and code alone', () => {
    const kept = 'H<sub>2</sub>O, <kbd>⌘</kbd>, <br/>, <details><summary>More</summary></details>';
    expect(escapeUnknownTags(kept)).toBe(kept);
    expect(escapeUnknownTags('See <https://x.dev> or <ada@x.dev>')).toBe(
      'See <https://x.dev> or <ada@x.dev>'
    );
    expect(escapeUnknownTags('Use `<action>` in code')).toBe('Use `<action>` in code');
    const fenced = '```xml\n<action>run</action>\n```';
    expect(escapeUnknownTags(fenced)).toBe(fenced);
  });

  it('leaves comparisons and arrows alone', () => {
    expect(escapeUnknownTags('if a < b and c > d then <- go ->')).toBe(
      'if a < b and c > d then <- go ->'
    );
  });
});

describe('projectRelativePath', () => {
  const mount = '/opt/projects/job-search';

  it('maps only paths inside this project mount', () => {
    expect(projectRelativePath('/opt/projects/job-search/letters/acme.md', mount)).toBe(
      'letters/acme.md'
    );
    expect(projectRelativePath('/opt/projects/other/acme.md', mount)).toBeNull();
    expect(projectRelativePath('acme.md', mount)).toBeNull();
    expect(projectRelativePath('/opt/projects/job-search', mount)).toBeNull();
    expect(projectRelativePath('/opt/projects/job-search/../x', mount)).toBeNull();
    expect(projectRelativePath('/opt/projects/job-search/a.md', null)).toBeNull();
  });
});
