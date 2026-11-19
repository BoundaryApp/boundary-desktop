import { describe, expect, it } from 'vitest';
import { cachedCheck, checkedBlocks } from '../writingCheckView';

describe('writing check view', () => {
  it('reuses the result for text it has already checked', () => {
    const text = 'We delve into it. I hope this helps!';
    expect(cachedCheck(text)).toBe(cachedCheck(text));
    expect(cachedCheck(`${text} `)).not.toBe(cachedCheck(text));
  });

  it('splits each block into runs at flag edges, overlaps included', () => {
    const markdown = '## Plan\n\nThis marks a pivotal moment. Done.';
    const result = cachedCheck(markdown);
    const blocks = checkedBlocks(markdown, result);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph']);
    const runs = blocks[1].runs.map((run) => [
      run.text,
      run.flags.map((i) => result.flags[i].rule).sort(),
    ]);
    expect(runs).toEqual([
      ['This marks a ', []],
      ['pivotal', ['ai-vocabulary', 'significance']],
      [' moment', ['significance']],
      ['. Done.', []],
    ]);
  });

  it('highlights a bold lead-in through its markers', () => {
    const markdown = '- **Speed:** fast\n- **Quality:** good\n- **Cost:** low';
    const result = cachedCheck(markdown);
    const first = checkedBlocks(markdown, result)[0];
    expect(first.runs[0].text).toBe('Speed:');
    expect(first.runs[0].flags.map((i) => result.flags[i].rule)).toEqual(['inline-header-list']);
  });
});
