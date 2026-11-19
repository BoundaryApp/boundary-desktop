import React from 'react';
import type { HermesHeldTurn } from '../../../shared/types/hermesChat';

/** A chat's name and how to open it, as the chat screen resolves a session id. */
export type ChatLink = { label: string; open: () => void } | null;

/**
 * Under a sent message that waits in Boundary for the local model (workload plan Phase 1a,
 * step 4): which chat it is waiting for, or how many turns are ahead, and **Run now**. Main
 * sends session ids only; names come from the chat list.
 */
export const HeldTurnLine: React.FC<{
  held: HermesHeldTurn;
  resolveChat?: (sessionId: string) => ChatLink;
  onRunNow: () => void;
}> = ({ held, resolveChat, onRunNow }) => {
  const links = held.runningSessionIds.map((id) => ({ id, link: resolveChat?.(id) ?? null }));
  const names = links.map(({ id, link }, index) => (
    <React.Fragment key={id}>
      {index > 0 ? ', ' : null}
      {link ? (
        <button type="button" className="wb-held-chat" onClick={link.open}>
          {link.label}
        </button>
      ) : (
        'another chat'
      )}
    </React.Fragment>
  ));
  return (
    <div className="wb-msg">
      <p className="wb-phase-line wb-held-line" role="status">
        <i className="wb-working-dot is-held" aria-hidden />
        <span>
          Waiting for the local model
          {held.ahead > 1 ? ` · ${held.ahead} ahead` : null}
          {names.length > 0 ? <> · answering in {names}</> : null}
        </span>
        <button type="button" className="wb-ending-act" onClick={onRunNow}>
          Run now
        </button>
      </p>
    </div>
  );
};
