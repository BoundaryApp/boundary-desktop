import React, { useCallback } from 'react';
import type {
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
} from '../../../shared/types/hermesChat';
import { InterruptCard } from '../../components/ui/interrupt-card';
import { credentialKicker, credentialNote, credentialWhy } from './credentialCopy';
import { CredentialNote } from './CredentialInterrupt';

interface CaptureSecretInterruptProps {
  request: HermesChatCredentialRequestEvent;
  queueSize: number;
  busy?: boolean;
  error?: string | null;
  /** `approve` absent = decline. */
  onRespond: (answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) => void;
}

/**
 * Hermes's `vault.capture_secret` card (stack CR 0024 R2): the agent has a page open that shows a
 * key and asks to store it without reading it. The card names the site, the variable name and the
 * key's last four characters; it never sees the key. Only `env` captures can be approved: a
 * `viewer` capture would hand the key to this app, which has nowhere to keep it yet.
 */
export const CaptureSecretInterrupt: React.FC<CaptureSecretInterruptProps> = ({
  request,
  queueSize,
  busy = false,
  error = null,
  onRespond,
}) => {
  const canApprove = !busy && request.destination === 'env';

  const approve = useCallback(() => {
    if (canApprove) onRespond({ approve: true });
  }, [canApprove, onRespond]);

  const decline = useCallback(() => {
    if (!busy) onRespond({});
  }, [busy, onRespond]);

  return (
    <InterruptCard
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        approve();
      }}
      className="wb-credential"
      labelledBy="wb-capture-secret-title"
      describedBy="wb-capture-secret-note"
      kicker={credentialKicker(request)}
      kickerId="wb-capture-secret-title"
      warn
      queueSize={queueSize}
      busy={busy}
      // Enter submits through the form.
      onEscape={decline}
    >
      <p className="why">{credentialWhy(request)}</p>
      <CredentialNote id="wb-capture-secret-note" note={credentialNote(request)} error={error} />
      <div className="wb-approve-actions">
        {request.destination === 'env' ? (
          <button type="submit" className="run" disabled={!canApprove}>
            Save key <kbd>↵</kbd>
          </button>
        ) : null}
        <button type="button" className="reject" disabled={busy} onClick={decline}>
          Decline
        </button>
      </div>
    </InterruptCard>
  );
};
