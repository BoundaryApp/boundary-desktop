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
import { calendarApprovalCopy, calendarSlugFromServer } from './calendarApprovalCopy';
import { InterruptCard, InterruptConfirm } from '../../components/ui/interrupt-card';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '../../components/ui/popover';

interface ApprovalInterruptProps {
  approval: HermesChatApprovalEvent;
  queueSize: number;
  busy?: boolean;
  /** Why the last answer was not sent. */
  error?: string | null;
  onRespond: (choice: HermesApprovalChoice) => void;
}

/** The account's display name for a `calendar-<slug>` server, once the list has loaded. */
function useCalendarAccountName(server: string | undefined): string | null {
  const slug = server ? calendarSlugFromServer(server) : null;
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    setName(null);
    if (!slug) return;
    let alive = true;
    try {
      void window.electronAPI.calendars
        .list()
        .then((result) => {
          const account = result.accounts.find((a) => a.slug === slug);
          if (alive && account) setName(account.name);
        })
        .catch((): void => undefined);
    } catch {
      /* No calendar API in this window: the card falls back to the slug. */
    }
    return () => {
      alive = false;
    };
  }, [slug]);
  return name;
}

export const ApprovalInterrupt: React.FC<ApprovalInterruptProps> = ({
  approval,
  queueSize,
  busy = false,
  error = null,
  onRespond,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [commandOpen, setCommandOpen] = useState(
    !approvalCommandCollapsed(approval.command)
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef<HTMLButtonElement | null>(null);

  const accountName = useCalendarAccountName(approval.mcp?.server);
  // Calendar writes get their own layout and only the two choices the gateway offers them.
  const calendar = useMemo(() => calendarApprovalCopy(approval.mcp, accountName), [approval.mcp, accountName]);
  const canOnce = approval.choices.includes('once');
  const canDeny = approval.choices.includes('deny');
  const canSession = !calendar && approval.choices.includes('session');
  const canAlways = !calendar && approval.choices.includes('always');
  const hasMore = canSession || canAlways;
  const command = approval.command?.trim() || '';
  const kicker = approvalKicker(approval);
  const why = approvalWhy(approval);

  useEffect(() => {
    setMenuOpen(false);
    setConfirmAlways(false);
    setCommandOpen(!approvalCommandCollapsed(approval.command));
  }, [approval.rpcRequestId, approval.command]);

  useEffect(() => {
    runRef.current?.focus();
  }, [approval.rpcRequestId]);

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

  const onEscape = () => {
    if (confirmAlways) setConfirmAlways(false);
    else if (canDeny) respond('deny');
  };

  return (
    <Popover open={menuOpen && hasMore} onOpenChange={setMenuOpen}>
      <PopoverAnchor virtualRef={hostRef} />
      <InterruptCard
        hostRef={hostRef}
        className={menuOpen ? 'is-menu' : undefined}
        labelledBy="wb-approve-title"
        kicker={calendar ? calendar.kicker : kicker}
        kickerId="wb-approve-title"
        warn={approval.smartDenied}
        queueSize={queueSize}
        busy={busy}
        onEscape={onEscape}
        onEnter={canOnce && !confirmAlways && !menuOpen ? () => respond('once') : undefined}
        aside={
          confirmAlways ? (
            <InterruptConfirm
              titleId="wb-approve-always"
              title="Always allow this command?"
              busy={busy}
              onCancel={() => setConfirmAlways(false)}
              onConfirm={() => respond('always')}
              confirmLabel="Always allow"
            >
              <p>{approvalAlwaysDescription()}</p>
              {command ? <pre className="cmd mono">{command}</pre> : null}
            </InterruptConfirm>
          ) : null
        }
      >
        {calendar ? (
          <div className="wb-approve-event">
            {calendar.title ? <p className="title">{calendar.title}</p> : null}
            {calendar.rows.length ? (
              <dl>
                {calendar.rows.map((row) => (
                  <React.Fragment key={row.label}>
                    <dt>{row.label}</dt>
                    <dd className={row.mono ? 'mono' : undefined}>{row.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            ) : null}
          </div>
        ) : (
          <p className="why">{why}</p>
        )}
        {command && !calendar ? (
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
        {error ? (
          <p className="wb-credential-error" role="alert">
            {error}
          </p>
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
              {calendar ? calendar.once : 'Run'} <kbd>↵</kbd>
            </button>
          ) : null}
          {canDeny ? (
            <button
              type="button"
              className="reject"
              disabled={busy}
              onClick={() => respond('deny')}
            >
              {calendar ? calendar.deny : 'Reject'}
            </button>
          ) : null}
          {hasMore ? (
            <PopoverTrigger>
              <button
                type="button"
                className="more"
                disabled={busy}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                More
              </button>
            </PopoverTrigger>
          ) : null}
        </div>
        {hasMore ? (
          <PopoverContent
            className="wb-approve-menu"
            role="menu"
            side="top"
            align="end"
            sideOffset={8}
            alignOffset={16}
          >
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
          </PopoverContent>
        ) : null}
      </InterruptCard>
    </Popover>
  );
};
