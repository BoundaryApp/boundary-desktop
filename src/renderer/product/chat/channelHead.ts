import type { ChannelRecord } from '../../../shared/types/hermesChat';

/** Room title is #slug. Subtitle is the channel name when it is not just the slug. */
export function formatChannelHead(
  channel: Pick<ChannelRecord, 'slug' | 'title'> | null | undefined,
  fallbackTitle?: string
): { title: string; subtitle: string | null } {
  const fromFallback = fallbackTitle?.trim().replace(/^#/, '') || '';
  const slug = (channel?.slug || fromFallback || 'channel').replace(/^#/, '');
  const rawTitle = (channel?.title || '').trim().replace(/^#/, '');
  const subtitle =
    rawTitle && rawTitle.toLowerCase() !== slug.toLowerCase() ? rawTitle : null;
  return { title: `#${slug}`, subtitle };
}
