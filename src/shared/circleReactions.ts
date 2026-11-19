/** The record app that holds Circle chat reactions (ADR 0057). */
export const REACTIONS_APP = 'reactions';

/** Most distinct emoji one member can keep on one message. */
export const MAX_REACTIONS_PER_MESSAGE = 20;

/** The emoji offered first in the picker. */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

const EMOJI = /^\p{RGI_Emoji}$/v;

/** True for exactly one RGI emoji sequence (ZWJ, flag and skin-tone sequences count as one). */
export const isReactionEmoji = (e: unknown): e is string => typeof e === 'string' && EMOJI.test(e);
