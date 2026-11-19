import { describe, expect, it } from 'vitest';
import { calendarSlug } from '../../types/calendars';
import { agentSlugFromDisplayName } from '../../types/hermesChat';
import { ADDON_SLUG, addonSlugFromName, slugify, uniqueSlug } from '../slug';

describe('slugify', () => {
  it('lowercases and joins runs of other characters with one hyphen', () => {
    expect(slugify('  Work & Family!! ')).toBe('work-family');
    expect(slugify('Kids’ soccer 2026')).toBe('kids-soccer-2026');
  });

  it('returns the fallback, or empty, when nothing is left', () => {
    expect(slugify('—!?')).toBe('');
    expect(slugify('—!?', { fallback: 'agent' })).toBe('agent');
  });

  it('caps the length and drops hyphens the cut leaves at the end', () => {
    expect(slugify('a'.repeat(45), { max: 40 })).toBe('a'.repeat(40));
    expect(slugify(`${'a'.repeat(47)} b`, { max: 48 })).toBe('a'.repeat(47));
  });
});

describe('slugify with stripDiacritics', () => {
  it('drops accents and splits compatibility characters before slugging', () => {
    expect(slugify('Crème Brûlée')).toBe('cr-me-br-l-e');
    expect(slugify('Crème Brûlée', { stripDiacritics: true })).toBe('creme-brulee');
    expect(slugify('ﬁnance Ⅻ', { stripDiacritics: true })).toBe('finance-xii');
    expect(slugify('日本語', { stripDiacritics: true, fallback: 'x' })).toBe('x');
  });
});

describe('addonSlugFromName', () => {
  it.each([
    ['Family Budget 2026', 'family-budget-2026'],
    ['Ñandú Ölçü', 'nandu-olcu'],
    ['9 lives', 'lives'],
    ['--Ärger--', 'arger'],
    ['a1-'.repeat(15), 'a1-a1-a1-a1-a1-a1-a1-a1-a1-a1-a'],
    ['2026', 'mail'],
  ])('%s → %s', (name, slug) => {
    expect(addonSlugFromName(name, 'mail')).toBe(slug);
    expect(ADDON_SLUG.test(slug)).toBe(true);
  });
});

describe('ADDON_SLUG', () => {
  it('takes a letter then up to 30 of a-z, 0-9 and -', () => {
    expect(ADDON_SLUG.test(`a${'b'.repeat(30)}`)).toBe(true);
    expect(ADDON_SLUG.test(`a${'b'.repeat(31)}`)).toBe(false);
    expect(ADDON_SLUG.test('9a')).toBe(false);
    expect(ADDON_SLUG.test('Ab')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('keeps a free base and counts up from 2 otherwise', () => {
    expect(uniqueSlug('notes', [])).toBe('notes');
    expect(uniqueSlug('notes', ['notes'])).toBe('notes-2');
    expect(uniqueSlug('notes', new Set(['notes', 'notes-2']))).toBe('notes-3');
  });
});

describe('callers', () => {
  // The connect sheet checks names with calendarSlug, so it agrees with main on long names.
  it('calendarSlug caps at 40', () => {
    expect(calendarSlug('a'.repeat(45))).toBe('a'.repeat(40));
    expect(calendarSlug(`${'a'.repeat(40)}x`)).toBe(calendarSlug(`${'a'.repeat(40)}y`));
  });

  it('agentSlugFromDisplayName caps at 48 and falls back to agent', () => {
    expect(agentSlugFromDisplayName('x'.repeat(60))).toHaveLength(48);
    expect(agentSlugFromDisplayName('!!')).toBe('agent');
  });
});
