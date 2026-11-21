import type { AgentProfile } from './types/hermesChat';
import { escapeRegExp } from './utils/escapeRegExp';

type MentionMember = Pick<AgentProfile, 'slug' | 'displayName' | 'handle'>;

/** One @name in text: the member it names and its `[start, end)` offsets. */
export interface MemberMentionSpan {
  slug: string;
  start: number;
  end: number;
}

/**
 * Every @token in text that names a channel member (display name, handle or slug), in text order.
 * Longer names win overlapping spans so "@UI/UX Designer" does not also match "@UI".
 */
export function memberMentionSpans(text: string, members: MentionMember[]): MemberMentionSpan[] {
  if (!text || members.length === 0) return [];

  const hits: MemberMentionSpan[] = [];
  for (const member of members) {
    const needles = [member.displayName, member.handle, member.slug]
      .map((s) => s.trim())
      .filter(Boolean);
    for (const needle of needles) {
      const re = new RegExp(`@(?:${escapeRegExp(needle)})(?![\\w-])`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        hits.push({ slug: member.slug, start: m.index, end: m.index + m[0].length });
      }
    }
  }

  const length = (span: MemberMentionSpan) => span.end - span.start;
  hits.sort((a, b) => length(b) - length(a) || a.start - b.start);
  const kept: MemberMentionSpan[] = [];
  for (const hit of hits) {
    const overlaps = kept.some((k) => !(hit.end <= k.start || hit.start >= k.end));
    if (!overlaps) kept.push(hit);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Resolve @tokens in text against channel members (display name, handle, slug).
 * Returns unique member slugs in first-mention order. Non-members are ignored.
 */
export function parseMemberMentions(text: string, members: MentionMember[]): string[] {
  const found: string[] = [];
  for (const span of memberMentionSpans(text, members)) {
    if (!found.includes(span.slug)) found.push(span.slug);
  }
  return found;
}
