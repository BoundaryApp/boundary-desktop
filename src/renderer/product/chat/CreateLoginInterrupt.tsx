import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
} from '../../../shared/types/hermesChat';
import { InterruptCard } from '../../components/ui/interrupt-card';
import { credentialKicker, credentialNote, credentialWhy } from './credentialCopy';
import { CredentialNote } from './CredentialInterrupt';

interface CreateLoginInterruptProps {
  request: HermesChatCredentialRequestEvent;
  queueSize: number;
  busy?: boolean;
  error?: string | null;
  /** `createLogin` absent = decline. */
  onRespond: (answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) => void;
}

/**
 * Hermes's `vault.create_login` card (stack CR 0024 R1): the agent has a sign-up form open and
 * asks to create the account's password. Approving lets Hermes generate one; the user can type
 * their own instead. A typed password lives only in this component's state until submit.
 */
export const CreateLoginInterrupt: React.FC<CreateLoginInterruptProps> = ({
  request,
  queueSize,
  busy = false,
  error = null,
  onRespond,
}) => {
  const [ownPassword, setOwnPassword] = useState(false);
  const [password, setPassword] = useState('');
  const passwordRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setOwnPassword(false);
    setPassword('');
  }, [request.rpcRequestId]);

  useEffect(() => {
    if (ownPassword) passwordRef.current?.focus();
  }, [ownPassword]);

  const canApprove = !busy && (!ownPassword || password.length > 0);

  const approve = useCallback(() => {
    if (!canApprove) return;
    const createLogin = ownPassword ? { password } : ({ generate: true } as const);
    setPassword('');
    onRespond({ createLogin });
  }, [canApprove, onRespond, ownPassword, password]);

  const decline = useCallback(() => {
    if (busy) return;
    setPassword('');
    onRespond({});
  }, [busy, onRespond]);

  return (
    <InterruptCard
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        approve();
      }}
      className="wb-credential"
      labelledBy="wb-create-login-title"
      describedBy="wb-create-login-note"
      kicker={credentialKicker(request)}
      kickerId="wb-create-login-title"
      warn
      queueSize={queueSize}
      busy={busy}
      // Enter submits through the form.
      onEscape={decline}
    >
      <p className="why">{credentialWhy(request)}</p>
      {ownPassword ? (
        <div className="wb-credential-fields">
          <label className="wb-field">
            <span>Password</span>
            <input
              ref={passwordRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="mono"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      <CredentialNote id="wb-create-login-note" note={credentialNote(request)} error={error} />
      <div className="wb-approve-actions">
        <button type="submit" className="run" disabled={!canApprove}>
          {ownPassword ? 'Use this password' : 'Generate password'} <kbd>↵</kbd>
        </button>
        <button type="button" className="reject" disabled={busy} onClick={decline}>
          Decline
        </button>
        <button
          type="button"
          className="more"
          disabled={busy}
          onClick={() => {
            setPassword('');
            setOwnPassword((value) => !value);
          }}
        >
          {ownPassword ? 'Generate one instead' : 'Use my own'}
        </button>
      </div>
    </InterruptCard>
  );
};
