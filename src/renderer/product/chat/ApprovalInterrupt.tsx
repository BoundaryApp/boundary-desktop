import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HermesApprovalChoice,
  HermesChatApprovalEvent,
} from '../../../shared/types/hermesChat';
import {
  approvalAlwaysDescription,
  approvalCommandCollapsed,
  approvalKicker,
  approvalWhy,
} from './approvalCopy';

interface ApprovalInterruptProps {
  approval: HermesChatApprovalEvent;
  queueSize: number;
  busy?: boolean;
  onRespond: (choice: HermesApprovalChoice) => void;
}

export const ApprovalInterrupt: React.FC<ApprovalInterruptProps> = ({
  approval,
  queueSize,
  busy = false,
  onRespond,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [commandOpen, setCommandOpen] = useState(
    !approvalCommandCollapsed(approval.command)
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef<HTMLButtonElement | null>(null);

  const canOnce = approval.choices.includes('once');
  const canDeny = approval.choices.includes('deny');
  const canSession = approval.choices.includes('session');
  const canAlways = approval.choices.includes('always');
  const hasMore = canSession || canAlways;
  const command = approval.command?.trim() || '';
  const kicker = approvalKicker(approval);
  const why = approvalWhy(approval);
  const countLabel = queueSize > 1 ? `1 / ${queueSize}` : null;

  useEffect(() => {
    setMenuOpen(false);
    setConfirmAlways(false);
    setCommandOpen(!approvalCommandCollapsed(approval.command));
  }, [approval.rpcRequestId, approval.command]);

  useEffect(() => {
    runRef.current?.focus();
  }, [approval.rpcRequestId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const respond = useCallback(
    (choice: HermesApprovalChoice) => {
      if (busy) return;
      if (!approval.choices.includes(choice)) return;
      setMenuOpen(false);
      setConfirmAlways(false);
      onRespond(choice);
    },
    [approval.choices, busy, onRespond]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmAlways) {
          setConfirmAlways(false);
          return;
        }
        if (menuOpen) {
          setMenuOpen(false);
          return;
        }
        if (canDeny) respond('deny');
        return;
      }
      if (event.key === 'Enter' && !confirmAlways && !menuOpen && canOnce) {
        event.preventDefault();
        respond('once');
      }
    },
    [canDeny, canOnce, confirmAlways, menuOpen, respond]
  );

  const stacked = queueSize > 1;
  const kickerClass = useMemo(
    () => (approval.smartDenied ? 'kicker is-warn' : 'kicker'),
    [approval.smartDenied]
  );

  return (
    <div className="wb-approve-host" ref={hostRef}>
      <div
        className={`wb-approve${stacked ? ' is-stack' : ''}${menuOpen ? ' is-menu' : ''}`}
        role="alertdialog"
        aria-labelledby="wb-approve-title"
        aria-busy={busy}
        onKeyDown={onKeyDown}
      >
        <div className={kickerClass}>
          <span id="wb-approve-title">{kicker}</span>
          {countLabel ? <span className="count">{countLabel}</span> : null}
        </div>
        <p className="why">{why}</p>
        {command ? (
          <>
            {approvalCommandCollapsed(approval.command) ? (
              <button
                type="button"
                className="cmd-toggle"
                onClick={() => setCommandOpen((open) => !open)}
              >
                Command
              </button>
            ) : null}
            {commandOpen || !approvalCommandCollapsed(approval.command) ? (
              <pre className="cmd mono">{command}</pre>
            ) : null}
          </>
        ) : null}
        <div className="wb-approve-actions">
          {canOnce ? (
            <button
              ref={runRef}
              type="button"
              className="run"
              disabled={busy}
              onClick={() => respond('once')}
            >
              Run <kbd>↵</kbd>
            </button>
          ) : null}
          {canDeny ? (
            <button
              type="button"
              className="reject"
              disabled={busy}
              onClick={() => respond('deny')}
            >
              Reject
            </button>
          ) : null}
          {hasMore ? (
            <button
              type="button"
              className="more"
              disabled={busy}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              onClick={() => setMenuOpen((open) => !open)}
            >
              More
            </button>
          ) : null}
        </div>
        {menuOpen && hasMore ? (
          <div className="wb-approve-menu" role="menu">
            {canSession ? (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => respond('session')}
              >
                Allow this session
                <em>Same pattern until this chat ends.</em>
              </button>
            ) : null}
            {canAlways ? (
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmAlways(true);
                }}
              >
                Always allow…
                <em>Durable allowlist. Confirm next.</em>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {confirmAlways ? (
        <div className="wb-approve-confirm" role="dialog" aria-labelledby="wb-approve-always">
          <h3 id="wb-approve-always">Always allow this command?</h3>
          <p>{approvalAlwaysDescription()}</p>
          {command ? <pre className="cmd mono">{command}</pre> : null}
          <div className="wb-approve-confirm-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setConfirmAlways(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => respond('always')}
            >
              Always allow
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
