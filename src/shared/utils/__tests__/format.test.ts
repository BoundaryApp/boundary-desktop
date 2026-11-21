import { describe, expect, it } from 'vitest';
import { abbreviateHome, formatBytes, formatTokenCount, joinNames } from '../format';

const GiB = 1024 ** 3;

describe('formatBytes', () => {
  it('uses binary units for every size', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(84 * 1024)).toBe('84 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(16 * GiB)).toBe('16 GB');
    expect(formatBytes(2 * 1024 * GiB)).toBe('2 TB');
  });

  it('keeps one decimal below 10 and drops a trailing .0', () => {
    expect(formatBytes(2 * GiB)).toBe('2 GB');
    expect(formatBytes(9.96 * GiB)).toBe('10 GB');
    expect(formatBytes(12.3 * GiB)).toBe('12 GB');
  });

  // The startup screen used decimal units and the Resources screen binary, both labelled GB.
  it('gives one reading for byte counts the old copies disagreed on', () => {
    expect(formatBytes(1.5e9)).toBe('1.4 GB');
    expect(formatBytes(5e8)).toBe('477 MB');
  });

  it('reads negative or non-finite input as 0 B', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatTokenCount', () => {
  it('rounds to K like formatBytes', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(6000)).toBe('6K');
    expect(formatTokenCount(6420)).toBe('6.4K');
    expect(formatTokenCount(32_768)).toBe('33K');
    expect(formatTokenCount(128_000)).toBe('128K');
  });

  // The context gauge and tool cards printed "18.8k" where the DM budget pill printed "19k".
  it('gives one reading for counts the old copies disagreed on', () => {
    expect(formatTokenCount(18_823)).toBe('19K');
    expect(formatTokenCount(6_020)).toBe('6K');
  });

  it('switches to M with the same rounding', () => {
    expect(formatTokenCount(1_048_576)).toBe('1M');
    expect(formatTokenCount(1_200_000)).toBe('1.2M');
    expect(formatTokenCount(12_500_000)).toBe('13M');
  });

  it('picks the unit after rounding, so it never reads 1000K or 1000', () => {
    expect(formatTokenCount(999_950)).toBe('1M');
    expect(formatTokenCount(999_600)).toBe('1M');
    expect(formatTokenCount(999.6)).toBe('1K');
    expect(formatTokenCount(999.4)).toBe('999');
  });
});

describe('joinNames', () => {
  it('joins with no comma before the last name', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['Maya'])).toBe('Maya');
    expect(joinNames(['Maya', 'Sam'])).toBe('Maya and Sam');
    expect(joinNames(['Maya', 'Sam', 'Priya'])).toBe('Maya, Sam and Priya');
    expect(joinNames(['you', 'Maya', 'Sam'], 'or')).toBe('you, Maya or Sam');
  });
});

describe('abbreviateHome', () => {
  it('reads a macOS or Linux home folder as ~', () => {
    expect(abbreviateHome('/Users/maya/code/app')).toBe('~/code/app');
    expect(abbreviateHome('/Users/maya')).toBe('~');
    expect(abbreviateHome('/home/maya/code/app')).toBe('~/code/app');
    expect(abbreviateHome('/home/maya')).toBe('~');
  });

  it('leaves other paths alone', () => {
    expect(abbreviateHome('/opt/stack')).toBe('/opt/stack');
    expect(abbreviateHome('/Users')).toBe('/Users');
    expect(abbreviateHome('/homework/x')).toBe('/homework/x');
  });
});
