import { useEffect, useRef } from 'react';
import { createValueStore } from '../../lib/valueStore';
import { dispatchAppCommand } from '../useAppShortcuts';

/** A chat another surface asked Chat to open, numbered so the same chat can be asked for twice. */
interface ChatOpenRequest {
  chatId: string;
  seq: number;
}

const request = createValueStore<ChatOpenRequest | null>(null);
let seq = 0;

/**
 * Go to Chat and open `chatId` there, as the desktop panel's ⤢ does (ADR 0058 §10). With no
 * chat, Chat opens on whatever it shows.
 */
export function requestChatOpen(chatId: string | null): void {
  if (chatId) {
    seq += 1;
    request.set({ chatId, seq });
  }
  dispatchAppCommand('go-chat');
}

/** Chat takes each request once, including one made before it mounted. */
export function useChatOpenRequests(handler: (chatId: string) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const pending = request.use();
  useEffect(() => {
    if (!pending) return;
    request.set(null);
    handlerRef.current(pending.chatId);
  }, [pending]);
}

/** @internal Vitest only. */
export function resetChatOpenRequestsForTests(): void {
  request.reset();
}
