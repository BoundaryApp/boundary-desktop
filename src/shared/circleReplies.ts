import { markdownToPlainText } from './markdownText';
import { HEX_KEY_PATTERN } from './hexKeys';
import { isRecord } from './utils/isRecord';
import type { CircleMessage, CircleMessageRef } from './types/circles';

/** The first Circle format where a chat message can carry `reply`. */
export const REPLIES_FORMAT = 3;

/** A message id: 16 to 32 lowercase hex characters. */
export const MESSAGE_ID_PATTERN = /^[0-9a-f]{16,32}$/;

/**
 * A `reply` as sent, checked for shape: a plain object with exactly `author` (an identity) and
 * `id` (a message id). The message it names may not exist. Null when malformed.
 */
export function cleanReply(value: unknown): CircleMessageRef | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('author') || !keys.includes('id')) return null;
  const { author, id } = value;
  if (typeof author !== 'string' || !HEX_KEY_PATTERN.test(author)) return null;
  if (typeof id !== 'string' || !MESSAGE_ID_PATTERN.test(id)) return null;
  return { author, id };
}

/** A quote shows at most this many characters of the original's first line. */
const QUOTE_CHARS = 120;

/** What a reply's quote shows, and whether the original was found, deleted or can't be found. */
export interface ReplyQuote {
  text: string;
  state: 'found' | 'deleted' | 'missing';
}

/**
 * The quote of a reply's original, read from its current record (ADR 0053 §4, §5): the first
 * line of its text with Markdown removed, cut to 120 characters. `null` is an original that
 * can't be found.
 */
export function replyQuoteText(
  message: { text: string; deleted: boolean | string | null; call?: CircleMessage['call'] } | null
): ReplyQuote {
  if (!message) return { state: 'missing', text: 'Original message not available' };
  if (message.deleted) return { state: 'deleted', text: 'Original message deleted' };
  if (message.call) return { state: 'found', text: 'Call' };
  const line = markdownToPlainText(message.text)
    .split('\n')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find(Boolean) ?? '';
  return { state: 'found', text: line.length > QUOTE_CHARS ? `${line.slice(0, QUOTE_CHARS).trimEnd()}…` : line };
}

/** Whether `message` replies to something `me` wrote. Replying to yourself doesn't count. */
export function repliesToMe(message: Pick<CircleMessage, 'reply' | 'author'>, me: string): boolean {
  return message.reply?.author === me && message.author !== me;
}
