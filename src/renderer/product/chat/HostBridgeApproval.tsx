import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InterruptCard, InterruptConfirm } from '../../components/ui/interrupt-card';
import type {
  HostBridgeApprovalChoice,
  HostBridgeApprovalEvent,
} from '../../../shared/types/hostBridge';
import { APP_NAME } from '../../../shared/buildIdentity';

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

  return (
    <InterruptCard
      labelledBy="wb-host-approve-title"
      kicker={`On this computer · ${approval.title}`}
      kickerId="wb-host-approve-title"
      queueSize={queueSize}
      busy={busy}
      onEscape={() => (confirmAlways ? setConfirmAlways(false) : respond('deny'))}
      onEnter={confirmAlways ? undefined : () => respond('allow')}
      aside={
        confirmAlways ? (
          <InterruptConfirm
            titleId="wb-host-approve-always"
            title={`Always allow: ${approval.title.toLowerCase()}?`}
            busy={busy}
            onCancel={() => setConfirmAlways(false)}
            onConfirm={() => respond('always')}
            confirmLabel="Always allow"
          >
            <p>{approval.alwaysDescription}</p>
          </InterruptConfirm>
        ) : null
      }
    >
      <p className="why">Hermes is asking {APP_NAME} to do this on your computer.</p>
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
    </InterruptCard>
  );
};
