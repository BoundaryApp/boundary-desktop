import React from 'react';
import type { Missed } from './callService';
import { openCallView, openCallViewOnJoin } from './callViewState';
import { useCallService } from './useCallService';
import { useElapsed } from './useElapsed';
import { Button } from '../../../components/ui/button';
import './calls.css';

const MISSED_TEXT: Record<Missed['reason'], (name: string) => string> = {
  'no-answer': () => 'No answer',
  busy: (name) => `${name} is in another call`,
  declined: (name) => `${name} declined`,
};

/**
 * The strip for this window's call: who it is with, how it is going and the controls that
 * matter without opening it. After a call that went unanswered it says why and offers another
 * try. Renders nothing when there is neither.
 */
export const CallBar: React.FC<{
  floating?: boolean;
  names: (circleKey: string, identity: string) => string;
}> = ({ floating, names }) => {
  const { call, missed, service } = useCallService();
  const elapsed = useElapsed(call?.connectedAt ?? null);
  const cls = `wb-callbar${floating ? ' is-floating' : ''}`;

  if (call) {
    const who = call.with ? names(call.circleKey, call.with) : 'Call';
    const status = call.dial === 'calling' ? `Calling ${who}…` : (elapsed ?? '');
    return (
      <div className={cls} role="region" aria-label="Call">
        <button type="button" className="wb-callbar-name" title="Open the call" onClick={openCallView}>
          <span className="wb-callbar-dot" aria-hidden />
          <span>{who}</span>
          <small>{status}</small>
        </button>
        <div className="wb-callbar-controls">
          <Button variant="secondary" size="sm" type="button" className={`${call.muted ? ' is-danger' : ''}`} onClick={() => call.mute(!call.muted)}>
            {call.muted ? 'Unmute' : 'Mute'}
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => void call.setCamera(!call.camera)}>
            {call.camera ? 'Camera off' : 'Camera on'}
          </Button>
          <Button variant="danger" size="sm" type="button" onClick={() => call.leave()}>
            Leave
          </Button>
        </div>
      </div>
    );
  }

  if (missed) {
    const who = names(missed.circleKey, missed.with);
    return (
      <div className={cls} role="region" aria-label="Call">
        <span className="wb-callbar-name">
          <span>{who}</span>
          <small>{MISSED_TEXT[missed.reason](who)}</small>
        </span>
        <div className="wb-callbar-controls">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            // A join that fails leaves the service as it was, and the bar shows that.
            onClick={() => openCallViewOnJoin(service.call(missed.circleKey, missed.with, { audio: true, video: false }))}
          >
            Try again
          </Button>
          <Button variant="secondary" size="sm" type="button" onClick={() => service.clearMissed()}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return null;
};
