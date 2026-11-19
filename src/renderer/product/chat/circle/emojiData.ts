import type { EmojiData, EmojiDataResolver } from 'frimousse';
import { isReactionEmoji } from '../../../../shared/circleReactions';

/** Newest Unicode emoji version shown when the picker passes none. macOS 13 and later draw version 15. */
const DEFAULT_EMOJI_VERSION = 15;

/** Frimousse numbers skin tones 1 to 5 in `skins[].tone`; its `skins` record is keyed by these names. */
const TONES = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'] as const;

/**
 * Emojibase 16.0.3 writes 152 emoji with a redundant U+FE0F (👍 comes as 👍 + FE0F), which is not
 * an RGI sequence. Main refuses those, and the string would differ from the quick pick's 👍, so
 * the picker hands back the RGI form.
 */
const rgi = (emoji: string): string => (isReactionEmoji(emoji) ? emoji : String(emoji).replaceAll('\uFE0F', ''));

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Frimousse's data for the picker, built from the `emojibase-data` package bundled with the app.
 * The two JSON files are dynamic imports so they build into their own chunk, loaded when the
 * picker first opens. Nothing is fetched: the renderer's CSP allows `connect-src 'self'` only, and
 * the packaged app loads from `file://`.
 *
 * Emoji newer than `options.emojiVersion` (15 when unset) are left out so older systems do not
 * draw empty boxes. Frimousse passes `emojiVersion` through only when the caller sets the prop.
 */
export const resolveEmojiData: EmojiDataResolver = async (locale, options) => {
  const [{ default: emojis }, { default: messages }] = await Promise.all([
    import('emojibase-data/en/data.json'),
    import('emojibase-data/en/messages.json'),
  ]);
  options.signal?.throwIfAborted();
  const cap = options.emojiVersion ?? DEFAULT_EMOJI_VERSION;
  const flags = messages.subgroups.filter((sub) => sub.key === 'country-flag' || sub.key === 'subdivision-flag').map((sub) => sub.order);
  const groups = messages.groups.filter((group) => group.key !== 'component');

  const data: EmojiData = {
    locale,
    categories: groups.map((group) => ({ index: group.order, label: capitalize(group.message) })),
    skinTones: Object.fromEntries(
      messages.skinTones.filter((tone) => TONES.includes(tone.key as (typeof TONES)[number])).map((tone) => [tone.key, capitalize(tone.message)])
    ) as EmojiData['skinTones'],
    emojis: [],
  };
  for (const entry of emojis) {
    if (entry.group === undefined || entry.version > cap) continue;
    const skins: Record<string, string> = {};
    for (const skin of entry.skins ?? []) {
      if (typeof skin.tone === 'number') skins[TONES[skin.tone - 1]] = rgi(skin.emoji);
    }
    data.emojis.push({
      emoji: rgi(entry.emoji),
      category: entry.group,
      label: capitalize(entry.label),
      version: entry.version,
      tags: entry.tags ?? [],
      countryFlag: entry.subgroup !== undefined && flags.includes(entry.subgroup) ? true : undefined,
      skins: Object.keys(skins).length > 0 ? (skins as NonNullable<EmojiData['emojis'][number]['skins']>) : undefined,
    });
  }
  return data;
};
