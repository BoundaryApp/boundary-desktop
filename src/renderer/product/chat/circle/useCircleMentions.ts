import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MENTIONS_FORMAT } from '../../../../shared/circleMentions';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { MentionPick } from '../../circles/useCircleChat';
import { mentionQueryFor, type MentionItem } from '../useMentionMenu';

/** The most rows the menu shows. */
const MAX_ITEMS = 8;
const CHANNEL_META = 'Everyone in this Circle who hasn’t turned it off';

interface DraftMentions {
  picked: MentionPick[];
  channel: boolean;
  /** The text at which the menu was dismissed; it stays closed until the text changes. */
  dismissedAt: string | null;
}

const NO_MENTIONS: DraftMentions = { picked: [], channel: false, dismissedAt: null };

/**
 * The @ menu for a Circle channel's composer: @channel, then the other members, online first.
 * Closed below format 3, where mentions aren't stored. `picked` and `channel` hold what the menu
 * inserted; main drops any whose `@Name` is no longer in the text, so they need no pruning here.
 */
export function useCircleMentions({
  circle,
  draftKey,
  text,
  setText,
  boxRef,
}: {
  circle: CircleSnapshot;
  /** Names the draft `text` belongs to; picks are kept per draft, like the text. */
  draftKey: string;
  text: string;
  setText: (text: string) => void;
  boxRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [drafts, setDrafts] = useState<Record<string, DraftMentions>>({});
  const [active, setActive] = useState(0);
  const draft = drafts[draftKey] ?? NO_MENTIONS;
  const { picked, channel, dismissedAt } = draft;
  const update = useCallback(
    (change: (now: DraftMentions) => DraftMentions) =>
      setDrafts((all) => ({ ...all, [draftKey]: change(all[draftKey] ?? NO_MENTIONS) })),
    [draftKey]
  );

  const query = circle.format >= MENTIONS_FORMAT ? mentionQueryFor(text) : null;
  const items = useMemo<MentionItem[]>(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const people = circle.members
      .filter((member) => !member.isMe && member.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.online) - Number(a.online))
      .map((member): MentionItem => ({
        kind: 'person',
        identity: member.identity,
        display: member.name,
        meta: member.online ? 'Online' : 'Away',
        online: member.online,
      }));
    const everyone: MentionItem[] = 'channel'.includes(q)
      ? [{ kind: 'channel', display: '@channel', meta: CHANNEL_META }]
      : [];
    return [...everyone, ...people].slice(0, MAX_ITEMS);
  }, [circle.members, query]);

  useEffect(() => setActive(0), [query]);

  const open = query !== null && items.length > 0 && dismissedAt !== text;
  const index = Math.min(active, Math.max(items.length - 1, 0));

  const pick = useCallback(
    (item: MentionItem) => {
      const typed = mentionQueryFor(text);
      if (typed === null) return;
      const name = item.kind === 'person' || item.kind === 'channel' ? item.display : null;
      if (!name) return;
      const next = `${text.slice(0, text.length - typed.length - 1)}${item.kind === 'channel' ? name : `@${name}`} `;
      if (item.kind === 'person') {
        update((now) => ({
          ...now,
          picked: now.picked.some((p) => p.identity === item.identity)
            ? now.picked
            : [...now.picked, { identity: item.identity, name }],
          dismissedAt: next,
        }));
      } else {
        update((now) => ({ ...now, channel: true, dismissedAt: next }));
      }
      setText(next);
      const box = boxRef.current;
      if (box) {
        box.focus();
        box.setSelectionRange(next.length, next.length);
      }
    },
    [text, setText, boxRef, update]
  );

  /** Handles ↑ ↓ Enter and Escape while the menu is open; true when the key was used. */
  const onKeyDown = (event: React.KeyboardEvent): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index + step + items.length) % items.length);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      update((now) => ({ ...now, dismissedAt: text }));
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      pick(items[index]);
      return true;
    }
    return false;
  };

  /** Clears this draft's picks, after its message was sent. */
  const reset = useCallback(() => update(() => NO_MENTIONS), [update]);

  return { open, items, index, pick, onKeyDown, picked, channel, reset };
}
