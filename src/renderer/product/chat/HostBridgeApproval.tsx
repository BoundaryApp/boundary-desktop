import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HostBridgeApprovalChoice,
  HostBridgeApprovalEvent,
} from '../../../shared/types/hostBridge';

interface HostBridgeApprovalProps {
  approval: HostBridgeApprovalEvent;
  queueSize: number;
  busy?: boolean;
  onRespond: (choice: HostBridgeApprovalChoice) => void;
}

/**
 * Consent card for a host tool Hermes called through Boundary's bridge (ADR 0027 §7). It sits in
 * the same composer slot and uses the same styles as Hermes's ApprovalInterrupt (ADR 0006), but
 * Boundary wrote every word on it.
 */
export const HostBridgeApproval: React.FC<HostBridgeApprovalProps> = ({
  approval,
  queueSize,
  busy = false,
  onRespond,
}) => {
  const [confirmAlways, setConfirmAlways] = useState(false);
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const countLabel = queueSize > 1 ? `1 / ${queueSize}` : null;

  useEffect(() => {
    setConfirmAlways(false);
    allowRef.current?.focus();
  }, [approval.id]);

  const respond = useCallback(
    (choice: HostBridgeApprovalChoice) => {
      if (busy || !approval.choices.includes(choice)) return;
      setConfirmAlways(false);
      onRespond(choice);
    },
    [approval.choices, busy, onRespond]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmAlways) setConfirmAlways(false);
        else respond('deny');
        return;
      }
      if (event.key === 'Enter' && !confirmAlways) {
        event.preventDefault();
        respond('allow');
      }
    },
    [confirmAlways, respond]
  );

  return (
    <div className="wb-approve-host">
      <div
        className={`wb-approve${queueSize > 1 ? ' is-stack' : ''}`}
        role="alertdialog"
        aria-labelledby="wb-host-approve-title"
        aria-busy={busy}
        onKeyDown={onKeyDown}
      >
        <div className="kicker">
          <span id="wb-host-approve-title" title={`On this computer · ${approval.title}`}>
            On this computer · {approval.title}
          </span>
          {countLabel ? <span className="count">{countLabel}</span> : null}
        </div>
        <p className="why">Hermes is asking Boundary to do this on your computer.</p>
        <pre className="cmd mono">{approval.detail}</pre>
        <div className="wb-approve-actions">
          <button
            ref={allowRef}
            type="button"
            className="run"
            disabled={busy}
            onClick={() => respond('allow')}
          >
            Allow <kbd>↵</kbd>
          </button>
          <button type="button" className="reject" disabled={busy} onClick={() => respond('deny')}>
            Deny
          </button>
          {approval.choices.includes('always') ? (
            <button
              type="button"
              className="more"
              disabled={busy}
              onClick={() => setConfirmAlways(true)}
            >
              Always allow…
            </button>
          ) : null}
        </div>
      </div>

      {confirmAlways ? (
        <div className="wb-approve-confirm" role="dialog" aria-labelledby="wb-host-approve-always">
          <h3 id="wb-host-approve-always">Always allow: {approval.title.toLowerCase()}?</h3>
          <p>{approval.alwaysDescription}</p>
          <div className="wb-approve-confirm-actions">
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirmAlways(false)}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => respond('always')}>
              Always allow
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
