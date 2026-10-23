import type { AgentProfile } from './types/hermesChat';

/**
 * Resolve @tokens in text against channel members (display name, handle, slug).
 * Returns unique member slugs in first-mention order. Non-members are ignored.
 * Longer names win overlapping spans so "@UI/UX Designer" does not also match "@UI".
 */
export function parseMemberMentions(
  text: string,
  members: Array<Pick<AgentProfile, 'slug' | 'displayName' | 'handle'>>
): string[] {
  if (!text || members.length === 0) return [];

  type Hit = { slug: string; start: number; end: number; len: number };
  const hits: Hit[] = [];

  for (const member of members) {
    const needles = [member.displayName, member.handle, member.slug]
      .map((s) => s.trim())
      .filter(Boolean);
    for (const needle of needles) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`@(?:${escaped})(?![\\w-])`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) != null) {
        hits.push({
          slug: member.slug,
          start: m.index,
          end: m.index + m[0].length,
          len: m[0].length,
        });
      }
    }
  }

  hits.sort((a, b) => b.len - a.len || a.start - b.start);
  const kept: Hit[] = [];
  for (const hit of hits) {
    const overlaps = kept.some((k) => !(hit.end <= k.start || hit.start >= k.end));
    if (!overlaps) kept.push(hit);
  }

  kept.sort((a, b) => a.start - b.start);
  const found: string[] = [];
  for (const hit of kept) {
    if (!found.includes(hit.slug)) found.push(hit.slug);
  }
  return found;
}
