import { useCallback, useEffect, useState } from 'react';
import type { CodingAccessRequestEvent } from '../../../shared/types/codingFolders';

/**
 * Coding-access requests for the open chat (ADR 0028 §9), oldest first. A path asked for twice
 * in the same turn shows once, and a path the user answered isn't asked again that turn.
 */
export function useCodingAccessRequests(
  sessionId: string | null,
  sameChat: (a: string, b: string) => boolean = (a, b) => a === b
) {
  const [requests, setRequests] = useState<CodingAccessRequestEvent[]>([]);
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());

  useEffect(
    () =>
      window.electronAPI.codingFolders.onAccessRequest((event) => {
        const key = `${event.requestId}:${event.hostPath}`;
        setRequests((prev) =>
          prev.some((item) => `${item.requestId}:${item.hostPath}` === key)
            ? prev
            : [...prev, event]
        );
      }),
    []
  );

  const mine = requests.filter(
    (item) =>
      sessionId !== null &&
      sameChat(item.sessionId, sessionId) &&
      !answered.has(`${item.requestId}:${item.hostPath}`)
  );

  const resolve = useCallback((request: CodingAccessRequestEvent) => {
    setAnswered((prev) => new Set(prev).add(`${request.requestId}:${request.hostPath}`));
    setRequests((prev) => prev.filter((item) => item.id !== request.id));
  }, []);

  return { request: mine[0] ?? null, queueSize: mine.length, resolve };
}
