import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
} from '../../../shared/types/hermesChat';
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

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Enter submits through the form.
      if (event.key === 'Escape') {
        event.preventDefault();
        skip();
      }
    },
    [skip]
  );

  const countLabel = queueSize > 1 ? `1 / ${queueSize}` : null;
  const valueLabel = credentialValueLabel(request);
  const isCode = request.kind === 'vault.code';

  return (
    <div className="wb-approve-host">
      <form
        className={`wb-approve wb-credential${queueSize > 1 ? ' is-stack' : ''}`}
        role="alertdialog"
        aria-labelledby="wb-credential-title"
        aria-describedby="wb-credential-note"
        aria-busy={busy}
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="kicker is-warn">
          <span id="wb-credential-title" title={credentialKicker(request)}>
            {credentialKicker(request)}
          </span>
          {countLabel ? <span className="count">{countLabel}</span> : null}
        </div>
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
      </form>
    </div>
  );
};
