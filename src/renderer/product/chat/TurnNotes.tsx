import React, { createContext, useContext } from 'react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type { HermesNoReply, HermesNoReplyReason } from '../../../shared/types/hermesChat';
import { useHistoryRefreshing } from './HermesChatRuntimeProvider';
import { RetryIcon, useCanRewind, useReplyEnding } from './MessageActions';
import { findRunningTurn, useRunningTurns } from './runningTurns';
import { formatElapsed, useNowSeconds } from './kanbanActivity';
import { WorkingDot } from './WorkingDot';
import { useMessageCustom } from './messageCustom';

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

const STOPPED: HermesNoReply = { reason: 'stopped' };

export function noReplyText(reason: HermesNoReplyReason, speakerName: string): string {
  switch (reason) {
    case 'stopped':
      return `Stopped before ${speakerName} replied`;
    case 'interrupted':
      return `Your next message came before ${speakerName} replied`;
    case 'failed':
      return `${speakerName} couldn’t reply`;
    case 'unreachable':
      return 'Your message wasn’t sent';
    case 'halted':
      return `${speakerName} stopped without replying`;
    case 'timeout':
      // Main gives up after TURN_QUIET_MS (3 minutes) without an event, once Hermes says the
      // session is idle or stops answering.
      return 'No reply after 3 minutes';
    case 'empty':
      return `${speakerName} finished without a reply`;
    case 'unknown':
    default:
      return 'No reply to this message';
  }
}

/** The line itself; Retry when the caller can rerun the turn. */
const NoReplyLine: React.FC<{
  noReply: HermesNoReply;
  speakerName: string;
  onRetry?: () => void;
}> = ({ noReply, speakerName, onRetry }) => (
  <p className="wb-turn-note" role="status">
    <i className="wb-ending-mark" aria-hidden="true" />
    {noReply.reason === 'unreachable' && noReply.error ? (
      <span>{noReply.error}</span>
    ) : (
      <span>{noReplyText(noReply.reason, speakerName)}</span>
    )}
    {noReply.error && noReply.reason !== 'unreachable' ? (
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
 * or in rooms, where a post without an @ wakes nobody on purpose. An earlier turn that failed
 * keeps its note, without Retry, once the chat moves on.
 */
export const UnansweredNote: React.FC<{ speakerName: string; inRoom: boolean }> = ({
  speakerName,
  inRoom,
}) => {
  const aui = useAui();
  const id = useAuiState((s) => s.message.id);
  const isLast = useAuiState((s) => s.message.isLast);
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  const { noReply: saved, localOnly } = useMessageCustom();
  const followedByUser = useAuiState((s) => s.thread.messages[s.message.index + 1]?.role === 'user');
  const canRewind = useCanRewind();
  const background = useChatRunningTurn();
  const refreshing = useHistoryRefreshing();
  if (inRoom) return null;
  if (!isLast) {
    if (!saved || saved.reason === 'stopped' || saved.reason === 'interrupted') return null;
    if (!localOnly && !followedByUser) return null;
    return <NoReplyLine noReply={saved} speakerName={speakerName} />;
  }
  if (threadRunning || background || refreshing) return null;
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
  if (!turn || threadRunning) return null;
  return <BackgroundTurnLine speakerName={speakerName} startedAt={turn.startedAt} />;
};

/** The note itself, with its own clock so it ticks only while it shows. */
const BackgroundTurnLine: React.FC<{ speakerName: string; startedAt: string }> = ({
  speakerName,
  startedAt,
}) => {
  const nowS = useNowSeconds(1000);
  const elapsed = nowS - Date.parse(startedAt) / 1000;
  return (
    <div className="wb-msg">
      <p className="wb-turn-note is-working" role="status">
        <WorkingDot label={`${speakerName} is working`} />
        <span>
          {speakerName} is still working · {formatElapsed(elapsed)}
        </span>
      </p>
    </div>
  );
};

/**
 * On a live reply that ended without any text (the turn failed, Hermes ended it, or you
 * stopped it): why. Retry is in the reply's own action row.
 */
export const LiveNoReplyNote: React.FC<{ speakerName: string }> = ({ speakerName }) => {
  const aui = useAui();
  const parentId = useAuiState((s) => s.message.parentId);
  const saved = useMessageCustom().noReply;
  const stoppedEmpty = useReplyEnding() === 'stopped-empty';
  const noReply = saved ?? (stoppedEmpty ? STOPPED : null);
  const hasText = useAuiState((s) =>
    s.message.content.some((part) => part.type === 'text' && part.text.trim().length > 0)
  );
  if (!noReply || hasText) return null;
  // Nothing reached Hermes, so this is the turn's one way back; the action row is for replies.
  const retry =
    noReply.reason === 'unreachable' && parentId ? () => aui.thread.startRun({ parentId }) : undefined;
  return <NoReplyLine noReply={noReply} speakerName={speakerName} onRetry={retry} />;
};
