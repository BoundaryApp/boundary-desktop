import { createContext, useContext, useEffect, useRef } from 'react';

type SameChat = (a: string, b: string) => boolean;

/**
 * Whether the open chat's id changing from `from` to `to` was the chat getting its real
 * session id in place (a send handing back an id). HermesChatRuntimeProvider provides it; it
 * is the only place that sees a new chat, which has no id at all, get its first one.
 */
export type IsAdoption = (from: string | null, to: string | null) => boolean;

export const ChatAdoptionContext = createContext<IsAdoption | null>(null);

/**
 * Runs `onSwitch` on mount and whenever the thread shows another chat. The open chat getting
 * its real session id (a DM placeholder's or a new chat's first send) is the same chat, so it
 * does not count.
 */
export function useOnChatSwitch(
  sessionId: string | null,
  sameChat: SameChat | undefined,
  onSwitch: () => void
): void {
  const isAdoption = useContext(ChatAdoptionContext);
  const isAdoptionRef = useRef(isAdoption);
  isAdoptionRef.current = isAdoption;
  const shownChatRef = useRef(sessionId);
  const onSwitchRef = useRef(onSwitch);
  onSwitchRef.current = onSwitch;
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;
  useEffect(() => {
    const prev = shownChatRef.current;
    shownChatRef.current = sessionId;
    if (prev !== sessionId) {
      if (prev && sessionId && sameChatRef.current?.(prev, sessionId)) return;
      if (isAdoptionRef.current?.(prev, sessionId)) return;
    }
    onSwitchRef.current();
  }, [sessionId]);
}
