import React, { useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '../../../shared/types/hermesChat';
import type { CalendarAccountView, MacCalendarSummary, MacStatusResult } from '../../../shared/types/calendars';
import { APP_NAME } from '../../../shared/buildIdentity';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Sheet } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { useMacStatus, type MacStatusState } from '../useCalendarAccounts';
import { Checkbox } from '../../components/ui/checkbox';

/** Calendars on this Mac: the allow and choose steps of the connect sheet, the card body and Edit calendars. */

const DENIED = `macOS won’t ask again. Turn on ${APP_NAME} under Calendars in Privacy & Security.`;
const MISSING = `${APP_NAME}’s calendar helper is missing from this build.`;
const STOPPED = 'The calendar helper stopped.';
const REVOKED = `Calendar access was turned off in System Settings. Agents can’t use This Mac until you turn ${APP_NAME} back on under Calendars in Privacy & Security.`;
const RESTART_FAILED = 'Couldn’t restart the calendar helper.';
const ASK_FAILED = 'Couldn’t ask for calendar access. Try again.';

/** Every calendar ticked except Birthdays and subscribed calendars. */
export function defaultTicked(calendars: readonly MacCalendarSummary[]): string[] {
  return calendars.filter((c) => c.kind !== 'birthdays' && c.kind !== 'subscribed').map((c) => c.id);
}

function OpenPrivacySettings() {
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    try {
      const result = await window.electronAPI.calendars.openPrivacySettings();
      if (!result.success) setError(result.error ?? 'Couldn’t open System Settings.');
    } catch {
      setError('Couldn’t open System Settings.');
    }
  };
  return (
    <>
      <Button variant="secondary" onClick={() => void open()}>
        Open Privacy Settings
      </Button>
      {error ? <p className="wb-sheet-error">{error}</p> : null}
    </>
  );
}

/** **Restart**: a fresh helper, then its status for the caller to show. */
function RestartHelper({ onRestarted }: { onRestarted: (status: MacStatusResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      onRestarted(await window.electronAPI.calendars.macRestartHelper());
    } catch {
      setError(RESTART_FAILED);
    }
    setBusy(false);
  };
  return (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => void restart()}>
        {busy ? 'Restarting…' : 'Restart'}
      </Button>
      {error ? <p className="wb-sheet-error">{error}</p> : null}
    </>
  );
}

function isDenied(access: MacStatusResult['access']): boolean {
  return access === 'denied' || access === 'restricted' || access === 'writeOnly';
}

/** Asks macOS for calendar access. Calls `onGranted` with the calendars once access is granted, including on a focus re-check. */
export function MacAllowStep({
  titleId,
  onGranted,
}: {
  titleId: string;
  onGranted: (calendars: MacCalendarSummary[]) => void;
}) {
  const { status, error, refresh, apply } = useMacStatus();
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => {
    if (status?.access === 'granted') onGranted(status.calendars);
  }, [status, onGranted]);

  const allow = async () => {
    setAsking(true);
    setAskError(null);
    try {
      apply(await window.electronAPI.calendars.macRequestAccess());
    } catch {
      setAskError(ASK_FAILED);
    }
    setAsking(false);
  };

  const access = status?.access;
  return (
    <>
      <h2 id={titleId}>Calendars on this Mac</h2>
      <p className="wb-sheet-lede">Agents you choose will see the events in the calendars you tick.</p>
      {access && isDenied(access) ? (
        <Callout variant="warn" layout="stacked" size="sm" className="wb-inference-callout" role={undefined}>
          <p>{DENIED}</p>
          <OpenPrivacySettings />
        </Callout>
      ) : access === 'missing' ? (
        <Callout variant="destructive" layout="block" size="sm" className="wb-inference-callout" role="alert">
          <p>{MISSING}</p>
        </Callout>
      ) : access === 'stopped' ? (
        <Callout variant="destructive" layout="stacked" size="sm" className="wb-inference-callout" role="alert">
          <p>{STOPPED}</p>
          <RestartHelper onRestarted={apply} />
        </Callout>
      ) : access === 'notDetermined' ? (
        <Button disabled={asking} onClick={() => void allow()}>
          {asking ? 'Waiting for macOS…' : 'Allow calendar access'}
        </Button>
      ) : null}
      {error ? (
        <>
          <p className="wb-sheet-error">{error}</p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </>
      ) : null}
      {askError ? <p className="wb-sheet-error">{askError}</p> : null}
    </>
  );
}

/** The Mac's calendars grouped by account, each with its colour, ticked or not. */
export function MacChooseStep({
  calendars,
  ticked,
  onChange,
  disabled,
}: {
  calendars: readonly MacCalendarSummary[];
  ticked: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const groups = useMemo(() => {
    const bySource = new Map<string, MacCalendarSummary[]>();
    for (const calendar of calendars) bySource.set(calendar.source, [...(bySource.get(calendar.source) ?? []), calendar]);
    return [...bySource.entries()];
  }, [calendars]);

  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (!next.delete(id)) next.add(id);
    onChange(calendars.filter((c) => next.has(c.id)).map((c) => c.id));
  };

  if (calendars.length === 0) return <p className="wb-vault-note">No calendars found on this Mac.</p>;

  return (
    <div className="wb-cal-mac-groups">
      {groups.map(([source, items]) => (
        <fieldset key={source} className="wb-cal-mac-group" disabled={disabled}>
          <legend>{source}</legend>
          {items.map((calendar) => (
            <label key={calendar.id} className="wb-cal-mac-row">
              <Checkbox checked={ticked.includes(calendar.id)} onChange={() => toggle(calendar.id)} />
              <span className="wb-cal-mac-swatch" style={{ background: calendar.color }} aria-hidden="true" />
              <span className="wb-cal-mac-title">{calendar.title}</span>
              {calendar.writable ? null : <span className="wb-cal-tag">Read only</span>}
            </label>
          ))}
        </fieldset>
      ))}
      {ticked.length === 0 ? <p className="wb-vault-note">Tick at least one calendar.</p> : null}
    </div>
  );
}

/** Edit calendars: change which of the Mac's calendars agents see. */
export function MacCalendarsSheet({
  account,
  onCancel,
  onSaved,
}: {
  account: CalendarAccountView;
  onCancel: () => void;
  onSaved: (account: CalendarAccountView | undefined) => void;
}) {
  const { status, error: statusError } = useMacStatus();
  const [ticked, setTicked] = useState<string[] | null>(null);
  const save = useSheetAction();
  const calendars = status?.access === 'granted' ? status.calendars : null;

  useEffect(() => {
    if (calendars && ticked === null) {
      const known = new Set(calendars.map((c) => c.id));
      setTicked((account.allowedCalendarIds ?? []).filter((id) => known.has(id)));
    }
  }, [calendars, ticked, account.allowedCalendarIds]);

  const submit = () =>
    save.run(async () => {
      const result = await window.electronAPI.calendars.macSetCalendars({ allowedCalendarIds: ticked ?? [] });
      if (!result.success) {
        save.setError(result.error ?? 'Couldn’t save the calendars.');
        return;
      }
      onSaved(result.account);
    });

  const problem = statusError ?? (status && !calendars ? macProblem(status.access) : null);
  return (
    <Sheet open onClose={onCancel} busy={save.busy} titleId="wb-cal-mac-edit-title" className="wb-vault-sheet wb-cal-sheet" backdropClassName="wb-vault-backdrop" kicker="Calendars on this Mac">
      <h2 id="wb-cal-mac-edit-title">Which calendars can agents see?</h2>
      {calendars && ticked ? (
        <MacChooseStep calendars={calendars} ticked={ticked} onChange={setTicked} disabled={save.busy} />
      ) : problem ? (
        <p className="wb-sheet-error">{problem}</p>
      ) : (
        <p className="wb-settings-hint">Loading calendars…</p>
      )}
      {save.error ? <p className="wb-sheet-error">{save.error}</p> : null}
      <div className="wb-sheet-actions wb-vault-sheet-actions">
        <Button variant="secondary" block type="button" disabled={save.busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" block type="button" disabled={save.busy || !ticked?.length} onClick={() => void submit()}>
          {save.busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Sheet>
  );
}

function macProblem(access: MacStatusResult['access']): string {
  if (isDenied(access)) return DENIED;
  if (access === 'missing') return MISSING;
  if (access === 'stopped') return STOPPED;
  return `${APP_NAME} doesn’t have access to the calendars on this Mac.`;
}

/** The This Mac card's dot and pill from the helper's live answer, or null to use the last test. */
export function macCardState(status: MacStatusResult | null): { tone: 'is-ok' | 'is-bad'; pill: string } | null {
  if (!status) return null;
  if (isDenied(status.access)) return { tone: 'is-bad', pill: 'Access off' };
  if (status.access === 'stopped') return { tone: 'is-bad', pill: 'Helper stopped' };
  if (status.access === 'missing') return { tone: 'is-bad', pill: 'Helper missing' };
  if (status.access === 'granted') return { tone: 'is-ok', pill: 'Connected' };
  return null;
}

/**
 * The This Mac card's details: the ticked calendars, the access state and who can use it. The
 * card owns the status check (`mac`), so its pill and these details agree.
 */
export function MacCardDetails({
  account,
  agents,
  mac,
}: {
  account: CalendarAccountView;
  agents: AgentProfile[];
  mac: MacStatusState;
}) {
  const { status, error, apply } = mac;
  const allowed = account.allowedCalendarIds ?? [];
  const names =
    status?.access === 'granted' ? status.calendars.filter((c) => allowed.includes(c.id)).map((c) => c.title) : null;
  const withAccess = agents.filter((a) => (account.access[a.slug] ?? 'off') !== 'off');
  const trouble = status && status.access !== 'granted' && status.access !== 'notDetermined' ? status.access : null;
  return (
    <>
      {trouble ? (
        <Callout variant="destructive" layout="stacked" size="sm" className="wb-inference-callout" role="alert">
          <p>{isDenied(trouble) ? REVOKED : macProblem(trouble)}</p>
          {isDenied(trouble) ? <OpenPrivacySettings /> : null}
          {trouble === 'stopped' ? <RestartHelper onRestarted={apply} /> : null}
        </Callout>
      ) : null}
      {error ? <p className="wb-sheet-error">{error}</p> : null}
      {status?.dropped?.length ? (
        <Callout variant="warn" layout="block" size="sm" className="wb-inference-callout" role={undefined}>
          <p>No longer on this Mac, so removed from the list: {status.dropped.join(', ')}.</p>
        </Callout>
      ) : null}
      <dl className="wb-inference-meta wb-cal-meta">
        <dt>Calendars</dt>
        <dd>
          {names ? (
            <span className="wb-cal-tags">
              {names.map((title, i) => (
                <span key={`${title}-${i}`} className="wb-cal-tag">
                  {title}
                </span>
              ))}
            </span>
          ) : (
            `${allowed.length} ticked`
          )}
        </dd>
        <dt>Access</dt>
        <dd>
          {withAccess.length
            ? withAccess
                .map((a) => `${a.displayName}: ${account.access[a.slug] === 'change' ? 'read and change' : 'read'}`)
                .join(' · ')
            : 'No agent can use it yet'}
        </dd>
      </dl>
      <p className="wb-vault-note">Works while {APP_NAME} is open.</p>
    </>
  );
}
