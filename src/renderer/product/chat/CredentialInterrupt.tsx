import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
} from '../../../shared/types/hermesChat';
import { InterruptCard } from '../../components/ui/interrupt-card';
import {
  credentialKicker,
  credentialNote,
  credentialValueLabel,
  credentialWhy,
} from './credentialCopy';

interface CredentialInterruptProps {
  request: HermesChatCredentialRequestEvent;
  queueSize: number;
  busy?: boolean;
  error?: string | null;
  /** `value` / `login` absent = skip. */
  onRespond: (answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) => void;
}

/**
 * Masked prompt for a Hermes credential request, in the ADR 0006 interrupt slot.
 * Values live only in this component's state until submit, and are cleared on
 * submit and on a new request.
 */
export const CredentialInterrupt: React.FC<CredentialInterruptProps> = ({
  request,
  queueSize,
  busy = false,
  error = null,
  onRespond,
}) => {
  const isLogin = request.kind === 'vault.save_login';
  const [identifier, setIdentifier] = useState('');
  const [value, setValue] = useState('');
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setIdentifier('');
    setValue('');
    firstRef.current?.focus();
  }, [request.rpcRequestId]);

  const canSave = value.length > 0 && !busy;

  const save = useCallback(() => {
    if (!canSave) return;
    const answer = isLogin ? { login: { identifier, password: value } } : { value };
    setValue('');
    setIdentifier('');
    onRespond(answer);
  }, [canSave, identifier, isLogin, onRespond, value]);

  const skip = useCallback(() => {
    if (busy) return;
    setValue('');
    setIdentifier('');
    onRespond({});
  }, [busy, onRespond]);

  const valueLabel = credentialValueLabel(request);
  const isCode = request.kind === 'vault.code';

  return (
    <InterruptCard
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="wb-credential"
      labelledBy="wb-credential-title"
      describedBy="wb-credential-note"
      kicker={credentialKicker(request)}
      kickerId="wb-credential-title"
      warn
      queueSize={queueSize}
      busy={busy}
      // Enter submits through the form.
      onEscape={skip}
    >
      <p className="why">{credentialWhy(request)}</p>
      <div className="wb-credential-fields">
        {isLogin ? (
          <label className="wb-field">
            <span>Username or email</span>
            <input
              ref={firstRef}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={identifier}
              disabled={busy}
              onChange={(event) => setIdentifier(event.target.value)}
            />
          </label>
        ) : null}
        <label className="wb-field">
          <span>{valueLabel}</span>
          <input
            ref={isLogin ? undefined : firstRef}
            type={isCode ? 'text' : 'password'}
            inputMode={isCode ? 'numeric' : undefined}
            autoComplete={isCode ? 'one-time-code' : 'off'}
            spellCheck={false}
            className={isCode ? undefined : 'mono'}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
      </div>
      <p className="wb-credential-note" id="wb-credential-note">
        {credentialNote(request)}
      </p>
      {error ? (
        <p className="wb-credential-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wb-approve-actions">
        <button type="submit" className="run" disabled={!canSave}>
          Save <kbd>↵</kbd>
        </button>
        <button type="button" className="reject" disabled={busy} onClick={skip}>
          Skip
        </button>
      </div>
    </InterruptCard>
  );
};
