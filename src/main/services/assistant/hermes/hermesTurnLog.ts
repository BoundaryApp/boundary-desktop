import { persistDebugLog } from '../../../persistDebugLog';
import type { HermesConversationKind } from '../../../../shared/types/hermesChat';
import type { MessageCompletePayload } from './vendor/gateway-contract.generated';

/**
 * Debug-log lines for chat turns (ADR 0031 §6). Metadata only: ids, slugs, counts, durations,
 * enum values and error names or codes. Never message text, titles, tool names or arguments,
 * or an error's message (it can echo what was sent).
 */

const AREA = 'chat-turn';

/** How a turn came to run: a user's send, an @ in a room, or another member's reply. */
export type TurnTrigger = 'sent' | 'woken' | 'chain-woken';

export type TurnOutcome =
  | 'completed'
  | 'stopped'
  | 'interrupted'
  /** Hermes ended the turn itself (`status: interrupted` on message.complete). */
  | 'halted'
  | 'failed'
  | 'timed-out';

export interface TurnLogFields {
  kind: HermesConversationKind;
  trigger: TurnTrigger;
  /** The agent the turn runs for; in a room, the member speaking. */
  agent: string | null;
  /** Hermes profile the turn runs in; null for the default profile. */
  profile: string | null;
  /** A room member's turn: its slug. */
  speaker?: string;
  /** Continue after Stop. */
  continued?: boolean;
  /** Edit / Retry, which truncates history first. */
  rewind?: boolean;
}

export interface TurnEnd {
  outcome: TurnOutcome;
  /** When the first text or tool call arrived (epoch ms); null when none came. */
  firstEventAt?: number | null;
  visibleTokens?: number;
  toolCalls?: number;
  error?: unknown;
  /** `message.complete`'s `error_surface.code`, an enum Hermes sets on a failed turn. */
  errorCode?: string | null;
}

export interface TurnLog {
  /** Write the end line once; later calls do nothing. */
  end(end: TurnEnd): void;
}

/** Error name and code, never the message. */
function errorIdentity(error: unknown): { errorName?: string; errorCode?: string | number } {
  if (error == null || typeof error !== 'object') return {};
  const err = error as { name?: unknown; code?: unknown };
  return {
    ...(typeof err.name === 'string' ? { errorName: err.name } : {}),
    ...(typeof err.code === 'string' || typeof err.code === 'number' ? { errorCode: err.code } : {}),
  };
}

export function startTurnLog(
  requestId: string,
  sessionId: string,
  fields: TurnLogFields
): TurnLog {
  const startedAt = Date.now();
  const ids = {
    requestId,
    sessionId,
    kind: fields.kind,
    trigger: fields.trigger,
    agent: fields.agent,
    profile: fields.profile,
    ...(fields.speaker ? { speaker: fields.speaker } : {}),
  };
  persistDebugLog(AREA, 'turn start', {
    ...ids,
    ...(fields.continued ? { continued: true } : {}),
    ...(fields.rewind ? { rewind: true } : {}),
  });
  let ended = false;
  return {
    end(end) {
      if (ended) return;
      ended = true;
      persistDebugLog(AREA, 'turn end', {
        ...ids,
        outcome: end.outcome,
        durationMs: Date.now() - startedAt,
        ttftMs: end.firstEventAt != null ? end.firstEventAt - startedAt : null,
        ...(end.visibleTokens != null ? { visibleTokens: end.visibleTokens } : {}),
        ...(end.toolCalls != null ? { toolCalls: end.toolCalls } : {}),
        ...errorIdentity(end.error),
        ...(end.errorCode ? { errorCode: end.errorCode } : {}),
      });
    },
  };
}

/** How a turn ended, from runJsonRpcTurn's finish reason and Hermes's completion. */
export function turnOutcome(
  finishReason: string | undefined,
  complete: MessageCompletePayload | undefined,
  signal: AbortSignal
): { outcome: TurnOutcome; errorCode?: string | null } {
  if (finishReason === 'cancel') {
    return { outcome: signal.reason === 'interrupted' ? 'interrupted' : 'stopped' };
  }
  if (finishReason === 'timeout') return { outcome: 'timed-out' };
  if (complete?.status === 'error') {
    return { outcome: 'failed', errorCode: complete.error_surface?.code ?? null };
  }
  if (complete?.status === 'interrupted') return { outcome: 'halted' };
  return { outcome: 'completed' };
}

/** A room send that @s no member: posted, and no turn runs. */
export function logPostWithoutTurn(requestId: string, sessionId: string): void {
  persistDebugLog(AREA, 'channel post, no turn', {
    requestId,
    sessionId,
    kind: 'channel',
    trigger: 'posted',
  });
}
