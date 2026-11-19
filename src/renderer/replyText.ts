import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_REPLY_TEXT,
  REPLY_TEXT_STORAGE_KEY,
  normalizeReplyText,
  type ReplyTextPreference,
} from '../shared/replyText';

// Reply text lives only in the renderer: nothing in the main process reads it, so localStorage
// is the store, read synchronously before React mounts so replies never paint at the old size.

const REPLY_TEXT_CHANGE_EVENT = 'boundary:reply-text';

function readStoredReplyText(): ReplyTextPreference {
  try {
    const stored = window.localStorage.getItem(REPLY_TEXT_STORAGE_KEY);
    return stored ? normalizeReplyText(JSON.parse(stored)) : DEFAULT_REPLY_TEXT;
  } catch {
    return DEFAULT_REPLY_TEXT;
  }
}

function storeReplyText(preference: ReplyTextPreference): void {
  try {
    window.localStorage.setItem(REPLY_TEXT_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Applied for this session; the next launch falls back to the default.
  }
}

/** Sets the prose tokens (tokens.css) on <html> so every .wb-prose picks them up. */
function applyReplyText(preference: ReplyTextPreference): void {
  const style = document.documentElement.style;
  style.setProperty('--font-reply', preference.face === 'sans' ? 'var(--font-ui)' : 'var(--font-prose)');
  style.setProperty('--size-prose', `${preference.size}px`);
  style.setProperty('--leading-prose', String(preference.lineHeight));
  style.setProperty('--prose-paragraph-gap', `${preference.paragraphGap}em`);
  style.setProperty('--prose-list-gap', `${preference.listGap}em`);
  // The serif has no weights between 400 and 600, so it always reads at 400.
  style.setProperty('--weight-prose', String(preference.face === 'sans' ? preference.weight : 400));
}

export function initReplyText(): void {
  applyReplyText(readStoredReplyText());
}

/** Current reply text and a setter that stores and applies it in every mounted control. */
export function useReplyText(): [ReplyTextPreference, (next: ReplyTextPreference) => void] {
  const [preference, setPreferenceState] = useState<ReplyTextPreference>(readStoredReplyText);

  useEffect(() => {
    const onChange = (event: Event) => {
      setPreferenceState((event as CustomEvent<ReplyTextPreference>).detail);
    };
    window.addEventListener(REPLY_TEXT_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(REPLY_TEXT_CHANGE_EVENT, onChange);
  }, []);

  const setPreference = useCallback((next: ReplyTextPreference) => {
    const valid = normalizeReplyText(next);
    storeReplyText(valid);
    applyReplyText(valid);
    window.dispatchEvent(new CustomEvent(REPLY_TEXT_CHANGE_EVENT, { detail: valid }));
  }, []);

  return [preference, setPreference];
}
