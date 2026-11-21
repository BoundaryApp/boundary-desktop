import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refKey } from '../../../../shared/circleMessageRef';
import type { CircleMessage, CircleMessageRef } from '../../../../shared/types/circles';


/**
 * Finds the original of each reply in a channel (ADR 0053 §4, §5). A target among `messages` is
 * read from there, so a quote follows its edits and deletes. Targets that aren't loaded are
 * fetched once through `chatMessage`, and again after each chat event in the channel, since that
 * update may bring a target that hadn't replicated or change one that had.
 *
 * The lookup returns `undefined` while a fetch is outstanding and `null` when the target wasn't found.
 */
export function useReplyTargets(
  circleKey: string,
  channel: string,
  messages: CircleMessage[]
): (ref: CircleMessageRef) => CircleMessage | null | undefined {
  const [fetched, setFetched] = useState<{ scope: string; found: Map<string, CircleMessage | null> }>(() => ({
    scope: '',
    found: new Map(),
  }));
  const [round, setRound] = useState(0);
  const scope = `${circleKey}/${channel}`;
  const found = fetched.scope === scope ? fetched.found : null;

  const loaded = useMemo(() => new Map(messages.map((message) => [refKey(message), message])), [messages]);
  // Reply targets that aren't loaded, as a stable string so the effects below run only when the set changes.
  const unloaded = useMemo(() => {
    const keys = new Set<string>();
    for (const message of messages) {
      if (message.reply && !loaded.has(refKey(message.reply))) keys.add(refKey(message.reply));
    }
    return [...keys].sort().join(',');
  }, [messages, loaded]);

  useEffect(() => {
    if (!unloaded) return;
    return window.electronAPI.circles.onChatEvent((update) => {
      if (update.circleKey === circleKey && update.channel === channel) setRound((n) => n + 1);
    });
  }, [circleKey, channel, unloaded]);

  // Targets asked for in this scope and round; a new round asks for them all again. Kept in a
  // ref so recording a request doesn't re-run the effect and drop the answer.
  const asked = useRef({ scope: '', round: -1, keys: new Set<string>() });
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // The newest round whose answer has been written, by target, in this scope.
  const answered = useRef(new Map<string, number>());
  useEffect(() => {
    if (!unloaded) return;
    if (asked.current.scope !== scope) answered.current = new Map();
    if (asked.current.scope !== scope || asked.current.round !== round) asked.current = { scope, round, keys: new Set() };
    for (const key of unloaded.split(',')) {
      if (asked.current.keys.has(key)) continue;
      asked.current.keys.add(key);
      const [author, id] = key.split('/');
      // A failed lookup reads as not found; the next chat event asks again. An answer from a round
      // older than one already written for this key is dropped, so it can't undo a newer answer.
      const write = (message: CircleMessage | null): void => {
        if (scopeRef.current !== scope || (answered.current.get(key) ?? -1) > round) return;
        answered.current.set(key, round);
        setFetched((was) => {
          const next = new Map(was.scope === scope ? was.found : []);
          next.set(key, message);
          return { scope, found: next };
        });
      };
      void window.electronAPI.circles.chatMessage({ key: circleKey, channel, author, id }).then(
        (result) => write(result.success === false ? null : result.message),
        () => write(null)
      );
    }
  }, [circleKey, channel, scope, unloaded, round]);

  return useCallback(
    (ref: CircleMessageRef) => {
      const key = refKey(ref);
      const message = loaded.get(key);
      if (message) return message;
      return found?.has(key) ? (found.get(key) ?? null) : undefined;
    },
    [loaded, found]
  );
}
