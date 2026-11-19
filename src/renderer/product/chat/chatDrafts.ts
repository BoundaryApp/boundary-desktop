// What was typed and not sent in each chat, for as long as the app runs. A chat's draft
// belongs to the chat, not the view: a view that opens the chat later starts from it.
// Kept in memory only; nothing is written to disk.

const drafts = new Map<string, string>();

/** The draft stored under any of a chat's ids, or null. */
export function readChatDraft(ids: readonly string[]): string | null {
  for (const id of ids) {
    const draft = drafts.get(id);
    if (draft) return draft;
  }
  return null;
}

/** Stores the draft under every id the chat goes by; empty text clears it. */
export function writeChatDraft(ids: readonly string[], text: string): void {
  for (const id of ids) {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
  }
}

/** @internal Vitest only. */
export function resetChatDraftsForTests(): void {
  drafts.clear();
}
