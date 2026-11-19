import { hasMentionToken } from '../../../../shared/circleMentions';
import type { CircleMentions, CircleSnapshot } from '../../../../shared/types/circles';

/** One `@name` to find in a message: the literal token and whether it is aimed at the user. */
export interface MentionToken {
  token: string;
  me: boolean;
}

/** One piece of a text run: plain text, or a mention. */
type MentionPiece = { text: string; mention?: { me: boolean } };

/**
 * The tokens a message's mentions give: `@name` for each listed person who is still a member,
 * under their current name, and `@channel` when the message mentions the channel. Longest first, so
 * `@Sam Lee` wins over `@Sam`.
 */
export function mentionTokens(circle: CircleSnapshot, mentions: CircleMentions | null): MentionToken[] {
  if (!mentions) return [];
  const tokens: MentionToken[] = [];
  for (const identity of mentions.members) {
    const member = circle.members.find((m) => m.identity === identity);
    if (member?.name) tokens.push({ token: `@${member.name}`, me: member.isMe });
  }
  if (mentions.channel) tokens.push({ token: '@channel', me: false });
  return tokens.sort((a, b) => b.token.length - a.token.length);
}

/** Splits `text` at every literal occurrence of a token; no pattern is built from a name. */
function splitMentions(text: string, tokens: MentionToken[]): MentionPiece[] {
  if (tokens.length === 0 || !text.includes('@')) return [{ text }];
  const pieces: MentionPiece[] = [];
  let plain = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', Math.max(at + 1, plain))) {
    const hit = tokens.find(({ token }) => {
      if (!text.startsWith(token, at)) return false;
      const next = text.charAt(at + token.length);
      return next === '' || !/\w/.test(next);
    });
    if (!hit) continue;
    if (at > plain) pieces.push({ text: text.slice(plain, at) });
    pieces.push({ text: hit.token, mention: { me: hit.me } });
    plain = at + hit.token.length;
  }
  if (plain < text.length) pieces.push({ text: text.slice(plain) });
  return pieces;
}

/** Current names of listed people who are still members and whose `@name` isn't in the message text. */
export function unmatchedNames(circle: CircleSnapshot, mentions: CircleMentions | null, text: string): string[] {
  if (!mentions) return [];
  const names: string[] = [];
  for (const identity of mentions.members) {
    const member = circle.members.find((m) => m.identity === identity);
    if (member?.name && !hasMentionToken(text, `@${member.name}`)) names.push(member.name);
  }
  return names;
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose text is not prose: a mention inside stays as typed. */
const SKIPPED = new Set(['code', 'pre', 'a']);

/**
 * A rehype plugin that wraps each token in `<span class="wb-circle-at">`. It builds hast nodes
 * from the text, so message text never goes through an HTML parser. Pass it to Streamdown as
 * `[rehypeMentions, { tokens }]`: Streamdown caches its processors by plugin name and options, so
 * the tokens must be in the options, not in a closure.
 */
export function rehypeMentions({ tokens }: { tokens: MentionToken[] }): (tree: HastNode) => void {
  const walk = (node: HastNode): void => {
    if (!node.children || (node.type === 'element' && node.tagName && SKIPPED.has(node.tagName))) return;
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type !== 'text' || !child.value) {
        walk(child);
        return [child];
      }
      const pieces = splitMentions(child.value, tokens);
      if (pieces.length === 1 && !pieces[0].mention) return [child];
      return pieces.map(
        (piece): HastNode =>
          piece.mention
            ? {
                type: 'element',
                tagName: 'span',
                properties: { className: piece.mention.me ? ['wb-circle-at', 'is-me'] : ['wb-circle-at'] },
                children: [{ type: 'text', value: piece.text }],
              }
            : { type: 'text', value: piece.text }
      );
    });
  };
  return walk;
}
