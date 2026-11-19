import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type { WritingVoiceView } from '../../../shared/types/writingVoices';

/** The query after a `/` that is the whole composer text, or null (writing voices spec, decision 4). */
function commandQueryFor(text: string): string | null {
  const match = /^\/([\w-]*)$/.exec(text);
  return match ? match[1] : null;
}

/**
 * The `/` command menu above the composer. Its one group so far is Writing voices: Enter puts
 * a voice on the message, Tab keeps it for the chat, Escape leaves the text to send as typed.
 */
export function useCommandMenu({
  voices,
  enabled,
  onPick,
}: {
  voices: WritingVoiceView[];
  /** False in a room: voices there are later work. */
  enabled: boolean;
  onPick: (voice: WritingVoiceView, keep: boolean) => void;
}) {
  const aui = useAui();
  // Read from the store, never mirrored from input events, so the caret isn't reset.
  const query = useAuiState((s) => commandQueryFor(s.composer.text));
  const text = useAuiState((s) => s.composer.text);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [index, setIndex] = useState(0);

  const items = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    return voices.filter((v) => v.status === 'ready' && v.name.toLowerCase().includes(q));
  }, [query, voices]);

  const showing = enabled && query !== null && dismissedFor !== text;

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    if (query === null) setDismissedFor(null);
  }, [query]);

  const pick = useCallback(
    (voice: WritingVoiceView, keep: boolean) => {
      aui.composer.setText('');
      setDismissedFor(null);
      onPick(voice, keep);
    },
    [aui, onPick]
  );

  /** Composer keys while the menu shows. True when it handled the key. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showing) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissedFor(text);
        return true;
      }
      if (items.length === 0) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + step + items.length) % items.length);
        return true;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        pick(items[Math.min(index, items.length - 1)], event.key === 'Tab');
        return true;
      }
      return false;
    },
    [showing, text, items, index, pick]
  );

  return { showing, query: query ?? '', items, index, handleKeyDown, pick };
}
