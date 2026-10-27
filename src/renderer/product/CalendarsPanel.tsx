import React, { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Lock, Plus } from 'lucide-react';
import type { AgentProfile } from '../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../shared/types/hermesChat';
import { useStoredAgents, useToast } from './settingsPanelHooks';
import type {
  CalendarAccess,
  CalendarAccountView,
  CalendarInfo,
  CalendarProgressStep,
  CalendarProvider,
  CalendarTestResult,
} from '../../shared/types/calendars';
import { calendarSlug } from '../../shared/types/calendars';
import { cloudInferenceNotice } from './cloudInferenceCopy';
import { useCalendarAccountList } from './useCalendarAccounts';
import { Sheet } from '../components/ui/sheet';
import { useSheetAction } from '../components/ui/use-sheet-action';
import { InfoTip } from '../components/ui/info-tip';

/** Settings → Calendars (docs/calendar-ux-study/spec.md, Phases 1 and 2). */

interface ProviderOption {
  id: CalendarProvider;
  label: string;
  hint: string;
  defaultName: string;
  userLabel: string;
  passwordLabel: string;
  /** Typed by the user, not filled in. */
  needsServer: boolean;
}

const PROVIDERS: ProviderOption[] = [
  {
    id: 'icloud',
    label: 'iCloud',
    hint: 'Needs an app-specific password',
    defaultName: 'Personal',
    userLabel: 'Apple ID email',
    passwordLabel: 'App-specific password',
    needsServer: false,
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    hint: 'Needs an app password with calendar access',
    defaultName: 'Fastmail',
    userLabel: 'Fastmail address',
    passwordLabel: 'App password',
    needsServer: false,
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud',
    hint: 'Your server address and an app password',
    defaultName: 'Nextcloud',
    userLabel: 'Username',
    passwordLabel: 'App password',
    needsServer: true,
  },
  {
    id: 'other',
    label: 'Other CalDAV server',
    hint: 'Radicale, Baïkal, Synology and others',
    defaultName: 'Calendar',
    userLabel: 'Username',
    passwordLabel: 'Password',
    needsServer: true,
  },
];

const PROVIDER_URL: Partial<Record<CalendarProvider, string>> = {
  icloud: 'https://caldav.icloud.com/',
  fastmail: 'https://caldav.fastmail.com/',
};

const APP_SPECIFIC = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/;
const UNSAFE_PASSWORD = /[\s'"\\#$]/;

const STEP_LABELS: Array<{ step: CalendarProgressStep; label: string }> = [
  { step: 'saving', label: 'Checked and saved the sign-in' },
  { step: 'access', label: 'Gave the agents access' },
  { step: 'checking', label: 'Checking Hermes can read it' },
];

const ACCESS_LEVELS: Array<{ level: CalendarAccess; label: string }> = [
  { level: 'off', label: 'Off' },
  { level: 'read', label: 'Read' },
  { level: 'change', label: 'Read and change' },
];

/** Why a provider usually stops accepting a password that used to work. */
const BROKEN_CAUSE: Record<CalendarProvider, string> = {
  icloud: 'This usually happens after an Apple ID password change, which cancels every app-specific password.',
  fastmail: 'This usually means the app password was revoked in Fastmail’s Privacy & Security settings.',
  nextcloud: 'This usually means the app password was revoked under Devices & sessions in Nextcloud.',
  other: 'This usually means the password was changed on the server.',
};

function providerOf(id: CalendarProvider): ProviderOption {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[3];
}

function shortDate(at: string | null | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function checkedAgo(at: string | undefined): string {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return `Checked ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

type SheetState =
  /** `fromChat`: opened by the chat's Connect a calendar card; closing it goes back there. */
  | { mode: 'connect'; fromChat?: boolean }
  | { mode: 'access'; account: CalendarAccountView }
  | { mode: 'password'; account: CalendarAccountView };

export const CalendarsPanel: React.FC<{
  cloudProvider?: string | null;
  /** Set when the chat's Connect calendar opened Settings: the sheet starts open and this runs if it's closed. */
  onConnectFromChatClosed?: () => void;
}> = ({ cloudProvider, onConnectFromChatClosed }) => {
  const agents = useStoredAgents();
  const { accounts: loaded, error: loadError, reload: refresh, replace } = useCalendarAccountList();
  const accounts = loaded ?? [];
  const loading = loaded === null && !loadError;
  const [sheet, setSheet] = useState<SheetState | null>(() =>
    onConnectFromChatClosed ? { mode: 'connect', fromChat: true } : null
  );
  const [toast, setToast] = useToast();
  /** A connect or access change in flight: the slug and its last step. */
  const [working, setWorking] = useState<{ slug: string; step: CalendarProgressStep } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  // Test every sign-in when the tab opens (spec Phase 2, item 3), once the stored list has
  // answered so it can't overwrite the result. Cards show the stored result until then.
  const rechecked = useRef(false);
  useEffect(() => {
    if (rechecked.current || (loaded === null && !loadError)) return;
    rechecked.current = true;
    void window.electronAPI.calendars
      .recheckAll()
      .then((result) => {
        if (result.success) replace(result.accounts);
      })
      .catch((): void => undefined);
  }, [loaded, loadError, replace]);

  useEffect(
    () =>
      window.electronAPI.calendars.onProgress((event) => {
        setWorking(event.step === 'done' ? null : { slug: event.slug, step: event.step });
      }),
    []
  );

  const knownAgents = agents.length
    ? agents
    : [{ slug: BUILTIN_ASSISTANT_SLUG, displayName: 'Hermes', handle: 'Hermes', role: '', builtIn: true, createdAt: '' }];

  const finished = (account: CalendarAccountView | undefined, message: string, note?: string) => {
    setSheet(null);
    setWorking(null);
    if (account) setNotes((prev) => ({ ...prev, [account.slug]: note ?? '' }));
    setToast(message);
    void refresh();
  };

  return (
    <div className="wb-vault wb-cal">
      <div className="wb-vault-toolbar">
        <p className="wb-inference-lead">
          Calendars your agents can read or change.
          <InfoTip label="calendars">
            Boundary connects over CalDAV, which iCloud, Fastmail and Nextcloud all support. Each agent
            gets only the calendars you give it.
          </InfoTip>
        </p>
        <span className="wb-vault-grow" />
        {accounts.length > 0 ? (
          <button
            type="button"
            className="wb-btn-ghost wb-vault-icon-btn"
            disabled={Boolean(working)}
            onClick={() => setSheet({ mode: 'connect' })}
          >
            <Plus size={14} aria-hidden="true" />
            Connect another calendar
          </button>
        ) : null}
      </div>

      {loadError ? (
        <div className="wb-vault-banner" role="alert">
          <span>{loadError}</span>
          <button type="button" className="wb-btn-ghost" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : loading ? (
        <p className="wb-settings-hint">Loading calendars…</p>
      ) : accounts.length === 0 && !working ? (
        <div className="wb-vault-list wb-vault-empty">
          <h3>No calendars connected</h3>
          <button
            type="button"
            className="wb-btn-solid wb-vault-icon-btn"
            onClick={() => setSheet({ mode: 'connect' })}
          >
            <Plus size={14} aria-hidden="true" />
            Connect calendar
          </button>
        </div>
      ) : (
        <div className="wb-cal-cards">
          {accounts.map((account) => (
            <AccountCard
              key={account.slug}
              account={account}
              agents={knownAgents}
              working={working?.slug === account.slug ? working.step : null}
              note={notes[account.slug] || null}
              onChangeAccess={() => setSheet({ mode: 'access', account })}
              onReplacePassword={() => setSheet({ mode: 'password', account })}
              onChanged={(message) => {
                setToast(message);
                void refresh();
              }}
            />
          ))}
        </div>
      )}

      {sheet ? (
        <ConnectSheet
          state={sheet}
          agents={knownAgents}
          takenSlugs={accounts.map((a) => a.slug)}
          cloudProvider={cloudProvider ?? null}
          working={working?.step ?? null}
          onCancel={() => {
            setSheet(null);
            if (sheet.mode === 'connect' && sheet.fromChat) onConnectFromChatClosed?.();
          }}
          onDone={finished}
        />
      ) : null}

      {toast ? (
        <div className="wb-vault-toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
};

function AccountCard({
  account,
  agents,
  working,
  note,
  onChangeAccess,
  onReplacePassword,
  onChanged,
}: {
  account: CalendarAccountView;
  agents: AgentProfile[];
  working: CalendarProgressStep | null;
  note: string | null;
  onChangeAccess: () => void;
  onReplacePassword: () => void;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState<'test' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providerOf(account.provider);
  const check = account.lastCheck;
  const tone = working ? 'is-busy' : check?.status === 'rejected' ? 'is-bad' : check?.status === 'unreachable' ? 'is-warn' : 'is-ok';
  const pill = working
    ? 'Connecting'
    : check?.status === 'rejected'
      ? 'Sign-in failed'
      : check?.status === 'unreachable'
        ? 'Unreachable'
        : 'Connected';
  const withAccess = agents.filter((a) => (account.access[a.slug] ?? 'off') !== 'off');
  const broken = check?.status === 'rejected' && !working;
  const subline = working
    ? ''
    : broken
      ? account.lastOkAt
        ? `Last worked ${shortDate(account.lastOkAt)}`
        : ''
      : checkedAgo(check?.at);

  const test = async () => {
    setBusy('test');
    setError(null);
    const result = await window.electronAPI.calendars.recheck({ slug: account.slug });
    setBusy(null);
    if (!result.success) {
      setError(result.error ?? 'Couldn’t test the sign-in.');
      return;
    }
    const status = result.account?.lastCheck?.status;
    onChanged(
      status === 'ok'
        ? `${account.name} is working`
        : status === 'rejected'
          ? `${provider.label} didn’t accept the ${account.name} password`
          : `Couldn’t reach ${provider.label}`
    );
  };

  const remove = async () => {
    setBusy('remove');
    setError(null);
    const result = await window.electronAPI.calendars.remove({ slug: account.slug });
    setBusy(null);
    if (!result.success) {
      setError(result.error ?? 'Couldn’t remove that calendar.');
      return;
    }
    onChanged(`Removed ${account.name}`);
  };

  return (
    <article className="wb-inference-card wb-cal-card" aria-label={account.name}>
      <div className="hed">
        <span className={`wb-inference-dot ${tone}`} aria-hidden="true" />
        <h3>{account.name}</h3>
        <span className={`wb-inference-pill ${tone}`}>{pill}</span>
        <span className="wb-cal-sub">{subline}</span>
      </div>

      {broken ? (
        <div className="wb-inference-banner is-bad" role="alert">
          <p>
            {provider.label} stopped accepting this password
            {shortDate(check?.at) ? ` on ${shortDate(check?.at)}` : ''}. Agents can’t use{' '}
            {account.name} until you replace it.
          </p>
          <p>{BROKEN_CAUSE[account.provider]}</p>
        </div>
      ) : null}
      {check?.status === 'unreachable' && !working ? (
        <div className="wb-inference-banner is-warn" role="alert">
          <p>The last test couldn’t reach {provider.label}. {check.error}</p>
        </div>
      ) : null}

      {working ? (
        <ProgressList step={working} />
      ) : (
        <dl className="wb-inference-meta wb-cal-meta">
          <dt>Provider</dt>
          <dd>
            {provider.label} <span className="mono">{account.url}</span>
          </dd>
          <dt>Account</dt>
          <dd>{account.username}</dd>
          <dt>Password</dt>
          <dd className="mono">{account.passwordTail ? `•••• ${account.passwordTail}` : 'Saved'}</dd>
          <dt>Calendars</dt>
          <dd>
            <CalendarTags calendars={account.calendars} />
          </dd>
          <dt>Access</dt>
          <dd>
            {withAccess.length
              ? withAccess
                  .map((a) => `${a.displayName}: ${account.access[a.slug] === 'change' ? 'read and change' : 'read'}`)
                  .join(' · ')
              : 'No agent can use it yet'}
          </dd>
          <dt>In chat</dt>
          <dd>“Check my {account.name} calendar”</dd>
        </dl>
      )}

      {note ? <p className="wb-inference-note">{note}</p> : null}
      {error ? <p className="wb-sheet-error">{error}</p> : null}

      {confirming ? (
        <div className="wb-vault-confirm" role="alertdialog" aria-label={`Remove ${account.name}`}>
          <p>
            Remove {account.name}? Agents lose access to it right away. Your calendar and its events
            stay as they are.
            {account.provider === 'icloud'
              ? ' You can also revoke the app-specific password at account.apple.com.'
              : ''}
          </p>
          <div className="wb-vault-confirm-actions">
            <button type="button" className="wb-btn-ghost" disabled={busy === 'remove'} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="wb-btn-danger" disabled={busy === 'remove'} onClick={() => void remove()}>
              {busy === 'remove' ? 'Removing…' : `Remove ${account.name}`}
            </button>
          </div>
        </div>
      ) : working ? null : (
        <div className="wb-inference-actions">
          {broken ? (
            <button type="button" className="wb-inference-btn is-solid" disabled={Boolean(busy)} onClick={onReplacePassword}>
              Replace password
            </button>
          ) : (
            <button type="button" className="wb-inference-btn" disabled={Boolean(busy)} onClick={() => void test()}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </button>
          )}
          <button type="button" className="wb-inference-btn" disabled={Boolean(busy)} onClick={onChangeAccess}>
            Change access
          </button>
          {broken ? null : (
            <button type="button" className="wb-inference-btn" disabled={Boolean(busy)} onClick={onReplacePassword}>
              Replace password
            </button>
          )}
          <button
            type="button"
            className="wb-inference-btn"
            disabled={Boolean(busy)}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Remove
          </button>
        </div>
      )}
    </article>
  );
}

function CalendarTags({ calendars }: { calendars: CalendarInfo[] }) {
  if (!calendars.length) return <>None found</>;
  return (
    <span className="wb-cal-tags">
      {calendars.map((c) => (
        <span key={c.url} className="wb-cal-tag">
          {c.name || 'Untitled'}
        </span>
      ))}
    </span>
  );
}

function ProgressList({ step }: { step: CalendarProgressStep }) {
  const at = STEP_LABELS.findIndex((s) => s.step === step);
  return (
    <ul className="wb-cal-progress" aria-live="polite">
      {STEP_LABELS.map((s, i) => {
        const state = i < at ? 'is-done' : i === at ? 'is-now' : '';
        return (
          <li key={s.step} className={state}>
            <span className="wb-cal-progress-mark" aria-hidden="true">
              {state === 'is-done' ? <Check size={11} /> : null}
            </span>
            {s.label}
          </li>
        );
      })}
    </ul>
  );
}

type ServiceState = { kind: 'starting' } | { kind: 'ready' } | { kind: 'failed'; error: string };

function ConnectSheet({
  state,
  agents,
  takenSlugs,
  cloudProvider,
  working,
  onCancel,
  onDone,
}: {
  state: SheetState;
  agents: AgentProfile[];
  takenSlugs: string[];
  cloudProvider: string | null;
  working: CalendarProgressStep | null;
  onCancel: () => void;
  onDone: (account: CalendarAccountView | undefined, message: string, note?: string) => void;
}) {
  const editing = state.mode === 'access' ? state.account : null;
  const replacing = state.mode === 'password' ? state.account : null;
  const [step, setStep] = useState<1 | 2 | 3>(editing ? 3 : replacing ? 2 : 1);
  const [provider, setProvider] = useState<CalendarProvider>(replacing?.provider ?? 'icloud');
  const [server, setServer] = useState(replacing?.url ?? '');
  const [username, setUsername] = useState(replacing?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState(providerOf('icloud').defaultName);
  const [nameTouched, setNameTouched] = useState(false);
  const [test, setTest] = useState<CalendarTestResult | { status: 'format' } | null>(null);
  const [testing, setTesting] = useState(false);
  const [service, setService] = useState<ServiceState>({ kind: editing ? 'ready' : 'starting' });
  const servicePromise = useRef<Promise<ServiceState> | null>(null);
  const [access, setAccess] = useState<Record<string, CalendarAccess>>(() =>
    editing
      ? { ...editing.access }
      : // Hermes starts on Read and change, every other agent on Off (spec decision 5).
        Object.fromEntries(agents.map((a) => [a.slug, a.builtIn ? 'change' : 'off']))
  );
  const save = useSheetAction();
  const { busy, error, setError } = save;

  // Start caldav-mcp now: the first start builds it, which overlaps with steps 1 and 2.
  useEffect(() => {
    if (editing) return;
    const p = window.electronAPI.calendars
      .prepare()
      .then((r): ServiceState => (r.success ? { kind: 'ready' } : { kind: 'failed', error: r.error ?? 'The calendar service didn’t start.' }))
      .catch((): ServiceState => ({ kind: 'failed', error: 'The calendar service didn’t start.' }));
    servicePromise.current = p;
    void p.then(setService);
  }, [editing]);

  const option = providerOf(provider);
  const slug = calendarSlug(name);
  const nameProblem = replacing
    ? null
    : !slug
    ? 'Give it a name with at least one letter or number.'
    : takenSlugs.includes(slug)
      ? `You already have a calendar called ${name.trim()}.`
      : null;
  const passwordProblem = password && UNSAFE_PASSWORD.test(password)
    ? 'Boundary can’t pass on a password with spaces, quotes, backslashes, # or $. Create an app password for Boundary instead.'
    : null;
  const ready = Boolean(username.trim() && password && !passwordProblem && !nameProblem && (!option.needsServer || server.trim()));

  const pickProvider = (id: CalendarProvider) => {
    setProvider(id);
    setServer('');
    setTest(null);
    if (!nameTouched) setName(providerOf(id).defaultName);
  };

  const runTest = async (skipFormat: boolean) => {
    if (!ready) return;
    if (!skipFormat && provider === 'icloud' && !APP_SPECIFIC.test(password.trim())) {
      setTest({ status: 'format' });
      return;
    }
    setTesting(true);
    setTest(null);
    const svc = service.kind === 'ready' ? service : await (servicePromise.current ?? Promise.resolve(service));
    if (svc.kind === 'failed') {
      setTesting(false);
      setTest({ status: 'error', error: svc.error });
      return;
    }
    const result = await window.electronAPI.calendars
      .test({ provider, url: server, username: username.trim(), password })
      .catch((): CalendarTestResult => ({ status: 'error', error: 'Couldn’t run the sign-in test.' }));
    setTesting(false);
    setTest(result);
  };

  const submit = () =>
    save.run(async () => {
      if (replacing) {
        const result = await window.electronAPI.calendars.replacePassword({
          slug: replacing.slug,
          password,
        });
        if (!result.success && !result.account) {
          setError(result.error ?? 'Couldn’t replace the password.');
          return;
        }
        setPassword('');
        onDone(result.account, `Replaced the ${replacing.name} password`, result.error);
        return;
      }
      if (editing) {
        const result = await window.electronAPI.calendars.setAccess({ slug: editing.slug, access });
        if (!result.success) {
          setError(result.error ?? 'Couldn’t change access.');
          return;
        }
        onDone(result.account, `Saved access to ${editing.name}`, result.error);
        return;
      }
      const result = await window.electronAPI.calendars.connect({
        provider,
        url: server,
        username: username.trim(),
        password,
        name: name.trim(),
        access,
      });
      if (!result.success) {
        if (result.account) {
          setPassword('');
          onDone(result.account, `${result.account.name} saved`, result.error);
          return;
        }
        setError(result.error ?? 'Couldn’t connect that calendar.');
        return;
      }
      setPassword('');
      const hermes = result.account?.access[BUILTIN_ASSISTANT_SLUG];
      onDone(
        result.account,
        `${name.trim()} connected${
          hermes === 'change' ? '. Hermes can read it and asks before changes.' : hermes === 'read' ? '. Hermes can read it.' : '.'
        }`,
        result.error
      );
    });

  const shownName = editing ? editing.name : replacing ? replacing.name : name.trim() || 'this calendar';
  const anyAccess = Object.values(access).some((v) => v !== 'off');
  const testLabel = testing
    ? service.kind === 'starting'
      ? 'Starting the calendar service…'
      : 'Checking…'
    : test?.status === 'rejected'
      ? 'Try again'
      : 'Test sign-in';

  return (
    <Sheet
      open
      onClose={onCancel}
      busy={busy}
      titleId="wb-cal-sheet-title"
      className="wb-vault-sheet wb-cal-sheet"
      backdropClassName="wb-vault-backdrop"
      kicker={editing ? 'Access' : replacing ? 'Replace password' : `Connect a calendar · ${step} of 3`}
    >
      {step === 1 ? (
        <>
          <h2 id="wb-cal-sheet-title">Where is your calendar?</h2>
          <p className="wb-sheet-lede">You can connect more than one. Each shows up in chat under its own name.</p>
          <div className="wb-cal-choices" role="radiogroup" aria-label="Provider">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={provider === p.id}
                className={`wb-inference-choice ${provider === p.id ? 'is-on' : ''}`}
                onClick={() => pickProvider(p.id)}
              >
                <span className="wb-inference-radio" aria-hidden="true" />
                <span>
                  <b>{p.label}</b>
                  <span>{p.hint}</span>
                </span>
              </button>
            ))}
          </div>
          <h3 className="wb-vault-label">Not supported yet</h3>
          <ul className="wb-cal-unsupported">
            <li>
              <b>Google Calendar.</b> Google’s CalDAV needs a Google sign-in, which Boundary can’t do yet.
            </li>
            <li>
              <b>Outlook and Microsoft 365.</b> Microsoft doesn’t offer CalDAV.
            </li>
          </ul>
        </>
      ) : null}

      {step === 2 ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (test?.status !== 'ok') void runTest(false);
            else if (replacing) void submit();
            else setStep(3);
          }}
        >
          <h2 id="wb-cal-sheet-title">
            {replacing ? `Replace the ${replacing.name} password` : `Sign in to ${option.label}`}
          </h2>
          <p className="wb-sheet-lede">
            {provider === 'icloud'
              ? 'iCloud only accepts an app-specific password here. Your Apple ID password won’t work.'
              : 'Use an app password if your provider offers one, so you can revoke it without changing your main password.'}
          </p>
          <SignInHelp provider={provider} />

          {option.needsServer && !replacing ? (
            <div className="wb-vault-field">
              <label htmlFor="wb-cal-server">Server address</label>
              <input
                id="wb-cal-server"
                className="mono"
                value={server}
                autoComplete="off"
                placeholder={provider === 'nextcloud' ? 'cloud.example.com' : 'dav.example.com'}
                onChange={(e) => {
                  setServer(e.target.value);
                  setTest(null);
                }}
              />
            </div>
          ) : null}
          <div className="wb-vault-field">
            <label htmlFor="wb-cal-user">{option.userLabel}</label>
            <input
              id="wb-cal-user"
              value={username}
              autoFocus={!replacing}
              disabled={Boolean(replacing)}
              autoComplete="off"
              onChange={(e) => {
                setUsername(e.target.value);
                setTest(null);
              }}
            />
          </div>
          <div className="wb-vault-field">
            <label htmlFor="wb-cal-password">{option.passwordLabel}</label>
            <div className="wb-vault-password">
              <input
                id="wb-cal-password"
                className="mono"
                autoFocus={Boolean(replacing)}
                type={showPassword ? 'text' : 'password'}
                value={password}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={provider === 'icloud' ? 'abcd-efgh-ijkl-mnop' : ''}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setTest(null);
                }}
              />
              <button
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
              </button>
            </div>
            {passwordProblem ? <p className="wb-sheet-error">{passwordProblem}</p> : null}
          </div>
          {replacing ? null : (
            <div className="wb-vault-field">
              <label htmlFor="wb-cal-name">Name</label>
              <input
                id="wb-cal-name"
                value={name}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
              <p className={nameProblem ? 'wb-sheet-error' : 'wb-vault-note'}>
                {nameProblem ?? `What you call it in chat: “check my ${name.trim()} calendar”.`}
              </p>
            </div>
          )}
          {!option.needsServer && !replacing ? (
            <details className="wb-cal-advanced">
              <summary>Server address</summary>
              <div className="wb-vault-field">
                <label htmlFor="wb-cal-server-adv">CalDAV address</label>
                <input
                  id="wb-cal-server-adv"
                  className="mono"
                  value={server}
                  autoComplete="off"
                  placeholder={PROVIDER_URL[provider]}
                  onChange={(e) => {
                    setServer(e.target.value);
                    setTest(null);
                  }}
                />
                <p className="wb-vault-note">Change this only if your provider gave you a different address.</p>
              </div>
            </details>
          ) : null}

          <TestResult result={test} providerLabel={option.label} onTestAnyway={() => void runTest(true)} />

          <p className="wb-vault-lockline">
            <Lock size={13} aria-hidden="true" />
            The password stays on this Mac and goes only to {option.label}. The model never sees it;
            agents reach your calendar through calendar tools.
          </p>
          {service.kind === 'failed' ? <p className="wb-sheet-error">{service.error}</p> : null}
          {replacing && busy && working ? <ProgressList step={working} /> : null}
          {replacing && error ? <p className="wb-sheet-error">{error}</p> : null}
          <div className="wb-sheet-actions wb-vault-sheet-actions">
            <button
              type="button"
              className="wb-btn-ghost"
              disabled={testing || busy}
              onClick={() => (replacing ? onCancel() : setStep(1))}
            >
              {replacing ? 'Cancel' : 'Back'}
            </button>
            {test?.status === 'ok' ? (
              <button type="submit" className="wb-btn-solid" disabled={busy}>
                {replacing ? (busy ? 'Saving…' : 'Save password') : 'Continue'}
              </button>
            ) : (
              <button type="submit" className="wb-btn-solid" disabled={!ready || testing}>
                {testLabel}
              </button>
            )}
          </div>
        </form>
      ) : null}

      {step === 3 ? (
        <>
          <h2 id="wb-cal-sheet-title">Who can use {shownName}?</h2>
          <p className="wb-sheet-lede">
            Each agent gets its own access. With Read and change, it asks you before every change.
          </p>
          <ul className="wb-cal-agents" aria-label="Agents">
            {agents.map((a) => (
              <li key={a.slug}>
                <span className="wb-cal-agent">
                  <b>{a.displayName}</b>
                  <span>{a.builtIn ? 'Your main agent' : a.role}</span>
                </span>
                <div className="wb-vault-seg" role="group" aria-label={`${a.displayName} access`}>
                  {ACCESS_LEVELS.map(({ level, label }) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={(access[a.slug] ?? 'off') === level}
                      disabled={busy}
                      onClick={() => setAccess((prev) => ({ ...prev, [a.slug]: level }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {cloudProvider && anyAccess ? (
            <div className="wb-inference-banner is-warn">
              <p>
                {cloudInferenceNotice(cloudProvider)} That includes event titles, notes and
                attendees.
              </p>
            </div>
          ) : null}
          {busy && working ? <ProgressList step={working} /> : null}
          {error ? <p className="wb-sheet-error">{error}</p> : null}
        </>
      ) : null}

      {step !== 2 ? (
        <div className="wb-sheet-actions wb-vault-sheet-actions">
          <button
            type="button"
            className="wb-btn-ghost"
            disabled={busy}
            onClick={() => (step === 3 && !editing ? setStep(2) : onCancel())}
          >
            {step === 3 && !editing ? 'Back' : 'Cancel'}
          </button>
          {step === 1 ? (
            <button type="button" className="wb-btn-solid" onClick={() => setStep(2)}>
              Continue
            </button>
          ) : (
            <button type="button" className="wb-btn-solid" disabled={busy} onClick={() => void submit()}>
              {busy ? (editing ? 'Saving…' : 'Connecting…') : editing ? 'Save' : 'Connect'}
            </button>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}

function SignInHelp({ provider }: { provider: CalendarProvider }) {
  if (provider === 'icloud') {
    return (
      <details className="wb-cal-help">
        <summary>How do I get an app-specific password?</summary>
        <ol>
          <li>
            Sign in at <span className="mono">account.apple.com</span>.
          </li>
          <li>Open Sign-In and Security, then App-Specific Passwords.</li>
          <li>Create one called “Boundary” and paste it below.</li>
        </ol>
        <p>Your Apple ID needs two-factor authentication turned on first.</p>
      </details>
    );
  }
  if (provider === 'fastmail') {
    return (
      <details className="wb-cal-help">
        <summary>How do I get an app password?</summary>
        <ol>
          <li>In Fastmail, open Settings, then Privacy &amp; Security.</li>
          <li>Create an app password with access to Calendars (CalDAV).</li>
          <li>Paste it below.</li>
        </ol>
      </details>
    );
  }
  if (provider === 'nextcloud') {
    return (
      <details className="wb-cal-help">
        <summary>How do I get an app password?</summary>
        <ol>
          <li>In Nextcloud, open Personal settings, then Security.</li>
          <li>Under Devices &amp; sessions, create an app password called “Boundary”.</li>
          <li>Paste it below with your server address.</li>
        </ol>
      </details>
    );
  }
  return (
    <details className="wb-cal-help">
      <summary>Which server address?</summary>
      <p>Use the CalDAV address your server shows, or its host name. Boundary looks for the calendar address from there.</p>
    </details>
  );
}

function TestResult({
  result,
  providerLabel,
  onTestAnyway,
}: {
  result: CalendarTestResult | { status: 'format' } | null;
  providerLabel: string;
  onTestAnyway: () => void;
}) {
  if (!result) return null;
  if (result.status === 'format') {
    return (
      <div className="wb-inference-banner is-warn" role="alert">
        <p>
          That doesn’t look like an app-specific password. Those are four groups of four letters,
          like abcd-efgh-ijkl-mnop. Your normal Apple ID password won’t work here.
        </p>
        <button type="button" className="wb-btn-ghost" onClick={onTestAnyway}>
          Test anyway
        </button>
      </div>
    );
  }
  if (result.status === 'rejected') {
    return (
      <div className="wb-inference-banner is-bad" role="alert">
        <p>
          {providerLabel} didn’t accept this username and password. Check that you pasted the app
          password. If you changed your account password since you made it, make a new one.
        </p>
      </div>
    );
  }
  if (result.status === 'unreachable' || result.status === 'error') {
    return (
      <div className="wb-inference-banner is-bad" role="alert">
        <p>
          {result.status === 'unreachable' ? `Couldn’t reach ${providerLabel}. ` : ''}
          {result.error}
        </p>
      </div>
    );
  }
  return (
    <div className="wb-cal-found" role="status">
      <p>
        <Check size={14} aria-hidden="true" /> Signed in. Agents will see{' '}
        {result.calendars.length === 1 ? 'this calendar' : `these ${result.calendars.length} calendars`}:
      </p>
      <CalendarTags calendars={result.calendars} />
    </div>
  );
}
