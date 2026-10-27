import { describe, expect, it } from 'vitest';
import { calendarSlug } from '../../types/calendars';
import { agentSlugFromDisplayName } from '../../types/hermesChat';
import { slugify, uniqueSlug } from '../slug';

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
