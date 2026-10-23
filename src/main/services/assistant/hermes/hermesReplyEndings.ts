import type {
  HermesChatMessage,
  HermesNoReply,
  HermesReplyEnding,
} from '../../../../shared/types/hermesChat';
import { getHermesGatewaySession } from './hermesGatewaySession';
import { getNoReplies, getReplyEndings, setNoReply, setReplyEnding } from './hermesAgentStore';

// Stopped and interrupted replies (run-control spec, Phase 1). Hermes saves a stopped
// turn's streamed text but not why it ended, and it may still be winding the turn down
// when the renderer moves on. This module waits for Hermes to confirm the stop before
// the next send on that session, and keeps Boundary's note of how the reply ended.

/** Continue: sent hidden. Hermes kept the partial, so the new reply picks up from it. */
export const CONTINUE_PROMPT =
  'Continue from where you stopped. Do not repeat what you already wrote.';

/** How long the next send waits for Hermes to confirm a stopped turn has ended. */
export const INTERRUPT_SETTLE_MS = 3000;

const settling = new Map<string, Promise<void>>();

/** Resolves once the session's last stopped turn has ended on Hermes (or the wait gave up). */
export function sessionSettled(sessionId: string): Promise<void> {
  return settling.get(sessionId) ?? Promise.resolve();
}

/**
 * Call right before `session.interrupt`. Waits for Hermes's `message.complete` for the
 * session (or INTERRUPT_SETTLE_MS), then notes how the reply ended against its row.
 * A turn stopped before any text has no reply row: Hermes saves nothing for it, so the
 * note goes on the unanswered user row instead.
 */
export function settleInterruptedTurn(
  sessionId: string,
  ending: HermesReplyEnding,
  hasPartial: boolean
): void {
  const gateway = getHermesGatewaySession();
  const confirmed = new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      unsubscribe();
      resolve();
    };
    unsubscribe = gateway.on('message.complete', (event) => {
      if (event.session_id && event.session_id !== sessionId) return;
      finish();
    });
    timer = setTimeout(finish, INTERRUPT_SETTLE_MS);
  });
  const settled: Promise<void> = confirmed
    .then(async (): Promise<void> => {
      if (hasPartial) await recordReplyEnding(sessionId, ending);
      else await recordNoReply(sessionId, { reason: ending });
    })
    .catch((): void => undefined)
    .finally((): void => {
      if (settling.get(sessionId) === settled) settling.delete(sessionId);
    });
  settling.set(sessionId, settled);
}

/** Note how the newest reply ended, keyed by its durable Hermes row (spec decision 3). */
async function recordReplyEnding(sessionId: string, ending: HermesReplyEnding): Promise<void> {
  const history = await getHermesGatewaySession().getSessionHistory(sessionId);
  const last = history[history.length - 1];
  if (last?.role === 'assistant' && last.rowId != null) {
    setReplyEnding(sessionId, last.rowId, ending);
  }
}

/**
 * Note why a turn ended without a reply, keyed by the unanswered user row. Only when the
 * transcript ends on that user row: if Hermes saved any reply, there is nothing to note.
 */
export async function recordNoReply(sessionId: string, noReply: HermesNoReply): Promise<void> {
  const history = await getHermesGatewaySession().getSessionHistory(sessionId);
  const last = history[history.length - 1];
  if (last?.role === 'user' && last.rowId != null) {
    setNoReply(sessionId, last.rowId, noReply);
  }
}

/** Hydrated history with each noted reply's ending, and each unanswered turn's reason. */
export function withReplyEndings(
  messages: HermesChatMessage[],
  sessionIds: Array<string | null | undefined>
): HermesChatMessage[] {
  const endings: Record<string, HermesReplyEnding> = {};
  const noReplies: Record<string, HermesNoReply> = {};
  for (const id of new Set(sessionIds)) {
    if (!id) continue;
    Object.assign(endings, getReplyEndings(id));
    Object.assign(noReplies, getNoReplies(id));
  }
  if (Object.keys(endings).length === 0 && Object.keys(noReplies).length === 0) {
    return messages;
  }
  return messages.map((m, i) => {
    if (m.rowId == null) return m;
    if (m.role === 'assistant') {
      const ending = endings[String(m.rowId)];
      return ending ? { ...m, ending } : m;
    }
    // A note only stands while the turn is still unanswered (a later Retry may succeed).
    const noReply = m.role === 'user' ? noReplies[String(m.rowId)] : undefined;
    const answered = messages[i + 1]?.role === 'assistant';
    return noReply && !answered ? { ...m, noReply } : m;
  });
}

export function resetReplyEndingsForTests(): void {
  settling.clear();
}
