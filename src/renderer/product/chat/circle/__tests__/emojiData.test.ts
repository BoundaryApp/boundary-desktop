import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReactionEmoji } from '../../../../../shared/circleReactions';
import { resolveEmojiData } from '../emojiData';

afterEach(() => vi.unstubAllGlobals());

describe('resolveEmojiData', () => {
  it('maps emojibase data to picker data without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const data = await resolveEmojiData('en', {});
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.locale).toBe('en');
    expect(data.categories.length).toBeGreaterThan(5);
    expect(data.categories.map((c) => c.label.toLowerCase())).not.toContain('component');
    const thumbs = data.emojis.find((e) => e.emoji === '👍');
    expect(thumbs?.skins?.dark).toBe('👍🏿');
    expect(Object.keys(thumbs?.skins ?? {})).toEqual(['light', 'medium-light', 'medium', 'medium-dark', 'dark']);
    expect(thumbs?.label).toBe('Thumbs up');
    expect(data.categories.some((c) => c.index === thumbs?.category)).toBe(true);
    expect(thumbs?.emoji).toBe('👍');
    expect(data.emojis.every((e) => isReactionEmoji(e.emoji) && Object.values(e.skins ?? {}).every(isReactionEmoji))).toBe(true);
    expect(data.skinTones.light).toBeTruthy();
    expect(data.emojis.filter((e) => e.countryFlag).length).toBeGreaterThan(200);
    expect(data.emojis.find((e) => e.emoji === '🇪🇺')?.countryFlag).toBe(true);
  });

  it('drops emoji newer than the version', async () => {
    const all = await resolveEmojiData('en', { emojiVersion: 99 });
    const old = await resolveEmojiData('en', { emojiVersion: 1 });
    expect(Math.max(...all.emojis.map((e) => e.version))).toBeGreaterThan(15);
    expect(Math.max(...old.emojis.map((e) => e.version))).toBeLessThanOrEqual(1);
    const fallback = await resolveEmojiData('en', {});
    expect(Math.max(...fallback.emojis.map((e) => e.version))).toBe(15);
  });
});
