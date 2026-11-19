import type { HermesChatThreadSummary } from '../../../shared/types/hermesChat';
import { newestFirst } from '../../../shared/utils/sort';
import { createStoredValue } from '../../lib/valueStore';

/**
 * The chat the agent panel shows, kept on this Mac (agent window spec decision 6). The desktop
 * panel's Agent tab and 0052's in-window window share it.
 */
const panelChat = createStoredValue<string | null>(
  'boundary:agent-panel-chat',
  null,
  (value): value is string | null => value === null || typeof value === 'string'
);

export const usePanelChat = (): string | null => panelChat.use();
export const setPanelChat = (id: string | null): void => panelChat.set(id);
export const panelChatNow = (): string | null => panelChat.get();

/** The built-in agent's chats the picker lists, newest first. */
export function agentChats(threads: readonly HermesChatThreadSummary[]): HermesChatThreadSummary[] {
  return threads.filter((thread) => thread.kind === 'hermes').sort(newestFirst);
}

/** The chat the panel lands on: the one it last showed while it is still listed, else the newest. */
export function landPanelChat(stored: string | null, threads: readonly HermesChatThreadSummary[]): string | null {
  const chats = agentChats(threads);
  if (stored && chats.some((thread) => thread.id === stored)) return stored;
  return chats[0]?.id ?? null;
}

/** @internal Vitest only. */
export function resetPanelChatForTests(): void {
  panelChat.reset();
}
