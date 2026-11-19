import type { CircleMentions, CircleNotifyLevel } from './types/circles';

/** The first Circle format where a message can carry `mentions` (ADR 0051 §8). */
export const MENTIONS_FORMAT = 3;

/** Largest Circle (the user included, agents excluded) where the default level is `all`. */
export const DEFAULT_ALL_MAX_PEOPLE = 6;

/** The level a Circle actually uses: `default` becomes `all` up to `DEFAULT_ALL_MAX_PEOPLE` people, else `mentions`. */
export function resolveNotifyLevel(level: CircleNotifyLevel, people: number): 'all' | 'mentions' | 'nothing' {
  if (level !== 'default') return level;
  return people <= DEFAULT_ALL_MAX_PEOPLE ? 'all' : 'mentions';
}

/** Whether a message's mentions are aimed at `identity`; a channel mention counts only when `channelMentions` is on. */
export function mentionsMe(mentions: CircleMentions | null, identity: string, channelMentions: boolean): boolean {
  if (!mentions) return false;
  return mentions.members.includes(identity) || (mentions.channel && channelMentions);
}

/** Whether `token` (`@name`) is in `text`, followed by a non-word character or the end. */
export function hasMentionToken(text: string, token: string): boolean {
  for (let from = text.indexOf(token); from !== -1; from = text.indexOf(token, from + 1)) {
    const next = text.charAt(from + token.length);
    if (next === '' || !/\w/.test(next)) return true;
  }
  return false;
}

/**
 * The mentions to send with a message: the distinct `picked` people whose `@name` is still in
 * `text` (followed by a non-word character or the end), and `@channel` when `channel` is set and
 * still there. Names match literally. Returns undefined when nothing is kept.
 */
export function keptMentions(
  text: string,
  picked: { identity: string; name: string }[],
  channel: boolean
): { members?: string[]; channel?: true } | undefined {
  const appears = (name: string): boolean => hasMentionToken(text, `@${name}`);
  const members = [...new Set(picked.filter((person) => person.name && appears(person.name)).map((person) => person.identity))];
  const keepChannel = channel && appears('channel');
  if (members.length === 0 && !keepChannel) return undefined;
  return { ...(members.length ? { members } : {}), ...(keepChannel ? { channel: true as const } : {}) };
}
