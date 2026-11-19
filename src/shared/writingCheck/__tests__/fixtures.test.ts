import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkText } from '../checkText';

/**
 * Two fixture sets, written for these tests: `plain/` avoids the patterns on purpose and stands
 * in for careful human prose; `assistant/` is in the default voice of a chat assistant. They are
 * a sanity check on the rules, not a calibration against real human writing.
 */
const dir = join(import.meta.dirname, 'fixtures');

function load(set: 'plain' | 'assistant'): Array<[string, string]> {
  return readdirSync(join(dir, set))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => [name, readFileSync(join(dir, set, name), 'utf8')]);
}

const plain = load('plain');
const assistant = load('assistant');

function density(set: Array<[string, string]>): number {
  const results = set.map(([, text]) => checkText(text));
  const flags = results.reduce((n, r) => n + r.flags.length, 0);
  const words = results.reduce((n, r) => n + r.words, 0);
  return (flags * 100) / words;
}

describe('writing check fixtures', () => {
  it('flags the assistant set far more densely than the plain set', () => {
    const plainDensity = density(plain);
    const assistantDensity = density(assistant);
    console.info(
      `writing check density: plain ${plainDensity.toFixed(2)}, assistant ${assistantDensity.toFixed(2)} flags per 100 words`
    );
    expect(assistantDensity).toBeGreaterThan(plainDensity * 4);
  });

  it.each(assistant)('flags %s at least once per 30 words', (_name, text) => {
    const result = checkText(text);
    expect(result.perHundredWords).not.toBeNull();
    expect(result.perHundredWords ?? 0).toBeGreaterThan(100 / 30);
  });

  it.each(plain)('flags %s at most once per 100 words', (_name, text) => {
    expect(checkText(text).perHundredWords ?? 0).toBeLessThanOrEqual(1);
  });

  it('gives every flag a non-empty span inside the source', () => {
    for (const [, text] of [...plain, ...assistant]) {
      for (const flag of checkText(text).flags) {
        expect(flag.start).toBeGreaterThanOrEqual(0);
        expect(flag.end).toBeGreaterThan(flag.start);
        expect(flag.end).toBeLessThanOrEqual(text.length);
        expect(text.slice(flag.start, flag.end).trim()).not.toBe('');
      }
    }
  });

  it('checks a 5,000-word document', () => {
    const all = [...plain, ...assistant].map(([, text]) => text).join('\n\n');
    let big = '';
    while (big.split(/\s+/).length < 5000) big += `${all}\n\n`;
    const result = checkText(big);
    expect(result.words).toBeGreaterThanOrEqual(5000);
    expect(result.flags.length).toBeGreaterThan(0);
  });
});
