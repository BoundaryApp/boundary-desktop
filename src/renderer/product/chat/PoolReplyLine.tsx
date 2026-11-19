import React, { createContext, useContext } from 'react';
import { useAuiState } from '@assistant-ui/store';
import type { TrustLevel } from '../../../shared/types/confidential';
import type { PoolServedTurn, TurnWindow } from '../../../shared/types/hermesChat';
import { LevelBadge } from '../inference/LevelBadge';
import { storedMessageTimeMs } from './messageMeta';
import { parseMessageTimes, type PlacedMarks, type TranscriptMark } from './TranscriptMarks';

// Which confidential provider wrote each reply, and where the chat moved to another one
// (confidential inference spec decision 9).

type RoleMessage = Parameters<typeof storedMessageTimeMs>[0] & { id: string; role: string };

/**
 * Each reply's time and id as one string, as `messageTimesKey` lists messages, for a store
 * selector. A reply counts with the time Hermes stored it, or, for a live reply, when main saw its
 * turn finish. Never the runtime's own date: that is when the run began, before main records the
 * turn's start, so the reply could be taken for the turn before.
 */
export function replyTimesKey(messages: readonly RoleMessage[]): string {
  return messages
    .flatMap((message) => {
      const ms = message.role === 'assistant' ? replyTimeMs(message) : null;
      return ms == null ? [] : [`${ms} ${message.id}`];
    })
    .join('\n');
}

function replyTimeMs(message: RoleMessage): number | null {
  const ended = message.metadata?.custom?.turnEndedAt;
  return storedMessageTimeMs(message) ?? (typeof ended === 'number' ? ended : null);
}

/**
 * How far a reply's stored time may sit outside its turn's window. Hermes stamps a row with its
 * own clock when it writes it, before it sends the turn's completion, but that clock runs in the
 * container VM and can drift from the host's.
 */
const TURN_WINDOW_TOLERANCE_MS = 5_000;

/**
 * The pool turn each reply belongs to. A reply belongs to a turn only when its time falls inside
 * exactly one turn window, each widened by `TURN_WINDOW_TOLERANCE_MS` on both edges (an open
 * window counts as running), and that window's turn has a pool record naming it. A reply written
 * while two turns ran, as with a queued send, near the edge between two, before the oldest window
 * kept, or outside every window gets no line. So does every reply of a window whose turn more than
 * one provider answered, even its only reply: post-turn requests such as titles and memory reviews
 * can go to another provider (ADR 0033 §7). A missing line is better than a wrong one.
 */
export function poolReplyTurns(
  turns: readonly PoolServedTurn[],
  windows: readonly TurnWindow[],
  replyTimes: string
): Map<string, PoolServedTurn> {
  const owners = new Map<string, PoolServedTurn>();
  const byWindow = new Map<string, PoolServedTurn>();
  for (const turn of turns) {
    if (turn.windowStartedAt) byWindow.set(turn.windowStartedAt, turn);
  }
  if (!byWindow.size) return owners;
  const spans = windows
    .map((w) => ({
      key: w.startedAt,
      start: Date.parse(w.startedAt),
      end: w.endedAt == null ? Infinity : Date.parse(w.endedAt),
    }))
    .filter((span) => Number.isFinite(span.start) && !Number.isNaN(span.end));
  if (!spans.length) return owners;
  // Older windows past the cap are gone, so a reply before the oldest kept one can't be placed.
  const oldest = Math.min(...spans.map((span) => span.start));
  const replies = new Map<string, string[]>();
  for (const reply of parseMessageTimes(replyTimes)) {
    if (reply.ms < oldest) continue;
    const inside = spans.filter(
      (span) => span.start - TURN_WINDOW_TOLERANCE_MS <= reply.ms && reply.ms <= span.end + TURN_WINDOW_TOLERANCE_MS
    );
    if (inside.length !== 1) continue;
    const key = inside[0].key;
    if (!byWindow.has(key)) continue;
    replies.set(key, [...(replies.get(key) ?? []), reply.id]);
  }
  for (const [key, ids] of replies) {
    const turn = byWindow.get(key)!;
    if (turn.mixedProviders) continue;
    for (const id of ids) owners.set(id, turn);
  }
  return owners;
}

/**
 * One marker per pool turn that moved the chat to another provider, above the first reply that
 * turn owns. A turn that owns no reply in the transcript gets none.
 */
export function poolMoveMarks(
  owners: ReadonlyMap<string, PoolServedTurn>,
  replyTimes: string,
  text: (turn: PoolServedTurn) => string | null
): PlacedMarks {
  const before = new Map<string, TranscriptMark[]>();
  const marked = new Set<PoolServedTurn>();
  const replies = parseMessageTimes(replyTimes).sort((a, b) => a.ms - b.ms);
  for (const reply of replies) {
    const turn = owners.get(reply.id);
    if (!turn || marked.has(turn)) continue;
    marked.add(turn);
    const said = text(turn);
    if (!said) continue;
    before.set(reply.id, [
      { id: `pool-move:${turn.at}:${turn.providerId}`, at: turn.at, text: said, className: 'wb-switch-mark wb-model-mark' },
    ]);
  }
  return { before, atEnd: [] };
}

export interface PoolReplyLineView {
  text: string;
  level: TrustLevel;
}

/** The line under each reply a pool answered, by message id. */
export const PoolReplyLinesContext = createContext<ReadonlyMap<string, PoolReplyLineView>>(new Map());

/** Under a reply a pool answered: the model, the provider and its level. */
export const PoolReplyLine: React.FC = () => {
  const lines = useContext(PoolReplyLinesContext);
  const id = useAuiState((s) => s.message.id);
  const line = lines.get(id);
  if (!line) return null;
  return (
    <div className="wb-reply-prov">
      {line.text}
      <LevelBadge level={line.level} />
    </div>
  );
};
