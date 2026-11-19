import React from 'react';
import { replyQuoteText } from '../../../../shared/circleReplies';
import type { CircleMessage } from '../../../../shared/types/circles';
import { keyHue } from '../../circles/CircleControls';

/** The rule takes the original author's avatar colour; an original that can't be found has none. */
const ruleStyle = (target: CircleMessage | null | undefined): React.CSSProperties | undefined =>
  target ? ({ '--quote-rule': keyHue(target.author) } as React.CSSProperties) : undefined;

/** The original's author as the quote names them: "You" for the user's own message. */
const quoteName = (target: CircleMessage): string => (target.mine && !target.agent ? 'You' : target.name);

/**
 * The strip above a reply's text (ADR 0053 §4, §5): the original's author and first line, as a
 * button that goes to it. A deleted original or one that can't be found shows that in italics and
 * isn't a button. `target` is `undefined` while the original is being looked up.
 */
export const ReplyQuote: React.FC<{
  target: CircleMessage | null | undefined;
  /** The original couldn't be reached when the user went to it. */
  unavailable: boolean;
  /** Null in select mode, where the quote is shown but doesn't go anywhere. */
  onGo: (() => void) | null;
}> = ({ target, unavailable, onGo }) => {
  if (target === undefined && !unavailable) return <div className="wb-circle-quote is-na" aria-hidden="true" />;
  const quote = replyQuoteText(unavailable ? null : (target ?? null));
  if (quote.state !== 'found' || !target) {
    return (
      <div className="wb-circle-quote is-na" style={ruleStyle(quote.state === 'deleted' ? target : null)}>
        {quote.text}
      </div>
    );
  }
  const whose = target.mine && !target.agent ? 'your' : `${target.name}'s`;
  const content = (
    <>
      <span className="wb-circle-quote-name">{quoteName(target)}</span>
      <span className="wb-circle-quote-text">{quote.text}</span>
    </>
  );
  if (!onGo) {
    return (
      <div className="wb-circle-quote" style={ruleStyle(target)}>
        {content}
      </div>
    );
  }
  return (
    <button type="button" className="wb-circle-quote" style={ruleStyle(target)} aria-label={`Go to ${whose} message`} onClick={onGo}>
      {content}
    </button>
  );
};

/** Above the composer while a reply is being written: who it answers, the quote and Cancel reply. */
export const ReplyStrip: React.FC<{ target: CircleMessage; onCancel: () => void }> = ({ target, onCancel }) => {
  const quote = replyQuoteText(target);
  return (
    <div className="wb-circle-reply-strip" role="group" aria-label="Reply" style={ruleStyle(target)}>
      <div className="wb-circle-reply-copy">
        <span className="wb-circle-reply-label">
          Replying to <b>{target.mine && !target.agent ? 'yourself' : target.name}</b>
        </span>
        <span className={`wb-circle-quote-text${quote.state === 'found' ? '' : ' is-na'}`}>{quote.text}</span>
      </div>
      <button type="button" className="wb-act" aria-label="Cancel reply" data-tip="Cancel reply" onClick={onCancel}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
};
