import { dispatchAppCommand } from '../useAppShortcuts';

// Text for the next new chat's composer. One slot: a later request replaces it.
let pending: string | null = null;

/** Start a chat with text ready to edit: opens a new chat and leaves `text` in its composer. */
export function startNewChatWithDraft(text: string): void {
  pending = text;
  dispatchAppCommand('new-chat');
}

/** The stored text, once. Later calls return null until another chat is started with text. */
export function takeNewChatDraft(): string | null {
  const text = pending;
  pending = null;
  return text;
}
