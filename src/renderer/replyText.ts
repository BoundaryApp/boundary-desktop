import { createStoredValue } from './lib/valueStore';
import {
  DEFAULT_REPLY_TEXT,
  REPLY_TEXT_STORAGE_KEY,
  normalizeReplyText,
  type ReplyTextPreference,
} from '../shared/replyText';

// Reply text lives only in the renderer: nothing in the main process reads it, so localStorage
// is the store, read synchronously before React mounts so replies never paint at the old size.

const replyText = createStoredValue<ReplyTextPreference>(
  REPLY_TEXT_STORAGE_KEY,
  DEFAULT_REPLY_TEXT,
  // The codec has already made any parsed value valid.
  (value): value is ReplyTextPreference => typeof value === 'object' && value !== null,
  { parse: (raw) => normalizeReplyText(JSON.parse(raw)), stringify: JSON.stringify }
);

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

const applyOnChange = (): (() => void) => replyText.subscribe(() => applyReplyText(replyText.get()));
applyOnChange();

export function initReplyText(): void {
  // Read storage afresh; the reset drops subscribers, so the apply step subscribes again.
  replyText.reset();
  applyOnChange();
  applyReplyText(replyText.get());
}

function setReplyText(next: ReplyTextPreference): void {
  replyText.set(normalizeReplyText(next));
}

/** Current reply text and a setter that stores and applies it in every mounted control. */
export function useReplyText(): [ReplyTextPreference, (next: ReplyTextPreference) => void] {
  return [replyText.use(), setReplyText];
}
