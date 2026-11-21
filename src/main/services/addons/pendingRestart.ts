import { getPendingAddonChanges, setPendingAddonChanges } from '../assistant/AssistantStackStore';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';

type Listener = (list: string[]) => void;
const listeners = new Set<Listener>();

/**
 * Add-on changes (Twenty, Todo lists, Actual, Circles) that take effect at the next assistant
 * restart, for the active stack root.
 */
export function pendingChanges(): string[] {
  const { root } = tryResolveAssistantRoot();
  return root ? getPendingAddonChanges(root) : [];
}

function replace(next: string[]): void {
  const { root } = tryResolveAssistantRoot();
  if (!root) return;
  const current = getPendingAddonChanges(root);
  if (next.length === current.length && next.every((text, i) => text === current[i])) return;
  setPendingAddonChanges(root, next);
  for (const cb of listeners) cb(next);
}

/** Adds a line. The same text twice stays one line. Does nothing while no stack root resolves. */
export function addPendingChange(text: string): void {
  const current = pendingChanges();
  if (!current.includes(text)) replace([...current, text]);
}

/** Drops every line `match` accepts. */
export function removePendingChanges(match: (text: string) => boolean): void {
  replace(pendingChanges().filter((text) => !match(text)));
}

/** Empties the list. Call it after any successful Hermes reload, since the reload applies all of it. */
export function clearPendingChanges(): void {
  replace([]);
}

/** Calls `cb` with the new list whenever it changes. Returns the unsubscribe function. */
export function onPendingChanges(cb: Listener): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/**
 * Reloads Hermes and clears the list. A failed reload keeps the list and rejects with the
 * reload's error.
 */
export async function applyPendingChanges(
  reload: () => Promise<{ success: boolean; error?: string }>
): Promise<void> {
  const result = await reload();
  if (!result.success) throw new Error(result.error ?? 'The assistant did not restart.');
  clearPendingChanges();
}
