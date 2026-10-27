import { describe, expect, it } from 'vitest';
import {
  extractPathsFromToolArgs,
  formatToolCardMeta,
  formatTurnStatsLine,
  toHostRelativePath,
} from '../../../../../shared/hermesToolPaths';

describe('extractPathsFromToolArgs', () => {
  it('reads path / file / target scalars', () => {
    expect(extractPathsFromToolArgs({ path: '/opt/projects/x/resume.pdf' })).toEqual([
      '/opt/projects/x/resume.pdf',
    ]);
    expect(extractPathsFromToolArgs({ file: 'notes.md' })).toEqual(['notes.md']);
    expect(extractPathsFromToolArgs({ target: 'a.txt' })).toEqual(['a.txt']);
  });

  it('reads paths / files arrays', () => {
    expect(
      extractPathsFromToolArgs({ paths: ['a.md', 'b.md'], files: [{ path: 'c.md' }] })
    ).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('returns empty for missing or junk args', () => {
    expect(extractPathsFromToolArgs(null)).toEqual([]);
    expect(extractPathsFromToolArgs({})).toEqual([]);
    expect(extractPathsFromToolArgs({ other: 1 })).toEqual([]);
  });
});

describe('toHostRelativePath', () => {
  it('strips container mount prefix', () => {
    expect(
      toHostRelativePath('/opt/projects/job/resume.pdf', '/opt/projects/job')
    ).toBe('resume.pdf');
  });

  it('strips /opt/projects/<slug>/ without explicit containerPath', () => {
    expect(toHostRelativePath('/opt/projects/job/cover.md')).toBe('cover.md');
  });
});

describe('formatToolCardMeta', () => {
  it('formats running with turn budget', () => {
    expect(
      formatToolCardMeta({
        name: 'search_files',
        status: 'running',
        turn: 2,
        maxTurns: 20,
      })
    ).toBe('Reading search_files · turn 2 of 20');
  });

  it('formats done', () => {
    expect(
      formatToolCardMeta({ name: 'search_files', status: 'done', turn: 2, maxTurns: 20 })
    ).toBe('Ran search_files · turn 2 of 20');
  });
});

describe('formatTurnStatsLine', () => {
  it('builds prompt / generated / visible / TTFT / tok/s rows', () => {
    expect(
      formatTurnStatsLine({
        prompt: 18823,
        generated: 708,
        visible: 7,
        ttftSec: 1.2,
        avgTps: 35,
      })
    ).toEqual([
      { label: 'prompt', value: '19k' },
      { label: 'generated', value: '708' },
      { label: 'visible', value: '7' },
      { label: 'TTFT', value: '1.2s' },
      { label: 'tok/s', value: '35' },
    ]);
  });
});
