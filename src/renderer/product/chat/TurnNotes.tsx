import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type { HermesNoReply, HermesNoReplyReason } from '../../../shared/types/hermesChat';
import { useHistoryRefreshing } from './HermesChatRuntimeProvider';
import { RetryIcon, useCanRewind } from './MessageActions';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { WorkingDot } from './WorkingDot';

// What the transcript says when a reply is not there: a turn still running on Hermes
// after its chat was reopened, or a turn that ended without any reply. Hermes saves
// nothing for a reply that never started, so without these the chat just ends on your
// message and looks like it is still waiting.

/** Which chat the transcript shows, for matching turns running on Hermes. */
export const TurnNoteContext = createContext<{
  chatId: string | null;
  sameChat?: (a: string, b: string) => boolean;
}>({ chatId: null });

function useChatRunningTurn() {
  const { chatId, sameChat } = useContext(TurnNoteContext);
  return findRunningTurn(useRunningTurns(), chatId, sameChat);
}

export function noReplyText(reason: HermesNoReplyReason, speakerName: string): string {
  switch (reason) {
    case 'stopped':
      return `Stopped before ${speakerName} replied`;
    case 'interrupted':
      return `Your next message came before ${speakerName} replied`;
    case 'failed':
      return `${speakerName} couldn’t reply`;
    case 'halted':
      return `${speakerName} stopped without replying`;
    case 'timeout':
      return `No reply after 10 minutes`;
    case 'empty':
      return `${speakerName} finished without a reply`;
    default:
      return 'No reply to this message';
  }
}

export function formatWorkingElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** The line itself; Retry when the caller can rerun the turn. */
export const NoReplyLine: React.FC<{
  noReply: HermesNoReply;
  speakerName: string;
  onRetry?: () => void;
}> = ({ noReply, speakerName, onRetry }) => (
  <p className="wb-turn-note" role="status">
    <i className="wb-ending-mark" aria-hidden="true" />
    <span>{noReplyText(noReply.reason, speakerName)}</span>
    {noReply.error ? (
      <span className="wb-turn-note-detail" title={noReply.error}>
        · {noReply.error}
      </span>
    ) : null}
    {onRetry ? (
      <button type="button" className="wb-ending-act" onClick={onRetry}>
        <RetryIcon />
        Retry
      </button>
    ) : null}
  </p>
);

/**
 * Under your latest message when no reply follows it: Boundary's note of why, or "No reply
 * to this message" when there is none. Nothing while a turn runs (the transcript shows it)
 * or in rooms, where a post without an @ wakes nobody on purpose.
 */
export const UnansweredNote: React.FC<{ speakerName: string; inRoom: boolean }> = ({
  speakerName,
  inRoom,
}) => {
  const aui = useAui();
  const id = useAuiState((s) => s.message.id);
  const isLast = useAuiState((s) => s.message.isLast);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const saved = useAuiState(
    (s) => (s.message.metadata as { custom?: { noReply?: HermesNoReply } } | undefined)?.custom
      ?.noReply
  );
  const canRewind = useCanRewind();
  const background = useChatRunningTurn();
  const refreshing = useHistoryRefreshing();
  if (inRoom || !isLast || threadRunning || background || refreshing) return null;
  const noReply: HermesNoReply = saved ?? { reason: 'unknown' };
  // After Send now the conversation has moved on; rerunning this turn would rewind it.
  const retry =
    canRewind && noReply.reason !== 'interrupted'
      ? () => aui.thread.startRun({ parentId: id })
      : undefined;
  return <NoReplyLine noReply={noReply} speakerName={speakerName} onRetry={retry} />;
};

/**
 * After the transcript, while a turn this screen did not start is still running on Hermes
 * (the chat was closed mid-turn and reopened). The reply loads when the turn ends.
 */
export const BackgroundTurnNote: React.FC<{ speakerName: string }> = ({ speakerName }) => {
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const turn = useChatRunningTurn();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!turn) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [turn]);
  if (!turn || threadRunning) return null;
  const elapsed = (now - Date.parse(turn.startedAt)) / 1000;
  return (
    <div className="wb-msg">
      <p className="wb-turn-note is-working" role="status">
        <WorkingDot label={`${speakerName} is working`} />
        <span>
          {speakerName} is still working · {formatWorkingElapsed(elapsed)}
        </span>
      </p>
    </div>
  );
};

/**
 * On a live reply that ended without any text (the turn failed, or Hermes ended it): why.
 * Retry is in the reply's own action row.
 */
export const LiveNoReplyNote: React.FC<{ speakerName: string }> = ({ speakerName }) => {
  const noReply = useAuiState(
    (s) => (s.message.metadata as { custom?: { noReply?: HermesNoReply } } | undefined)?.custom
      ?.noReply
  );
  const hasText = useAuiState((s) =>
    s.message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
  );
  if (!noReply || hasText) return null;
  return <NoReplyLine noReply={noReply} speakerName={speakerName} />;
};
