import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Lock, Plus } from 'lucide-react';
import type { AgentProfile } from '../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../shared/types/hermesChat';
import { builtinAgent, builtinAgentName } from '../../shared/hermesAgentIdentity';
import { useBuiltinAgentName, useStoredAgents, useToast } from './settingsPanelHooks';
import type {
  CalendarAccess,
  CalendarAccountView,
  CalendarInfo,
  CalendarProgressStep,
  CalendarProvider,
  CalendarTestResult,
  MacCalendarSummary,
} from '../../shared/types/calendars';
import { calendarSlug } from '../../shared/types/calendars';
import { cloudInferenceNotice } from './cloudInferenceCopy';
import { useCalendarAccountList, useMacStatus } from './useCalendarAccounts';
import { Sheet } from '../components/ui/sheet';
import { AppPasswordWalkthrough } from './calendar/AppPasswordWalkthrough';
import {
  MacAllowStep,
  MacCalendarsSheet,
  MacCardDetails,
  MacChooseStep,
  defaultTicked,
  macCardState,
} from './calendar/MacCalendarSteps';
import { APP_SPECIFIC, APP_SPECIFIC_FORMAT_WARNING } from './calendar/appSpecificPassword';
import { useSheetAction } from '../components/ui/use-sheet-action';
import { InfoTip } from '../components/ui/info-tip';
import { APP_NAME } from '../../shared/buildIdentity';
import { Callout, RetryCallout } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { ChoiceGroup } from '../components/ui/choice-group';
import { ChoiceRow } from '../components/ui/choice-row';
import { Radio } from '../components/ui/radio';
import { Segmented } from '../components/ui/segmented';
import { Field } from '../components/ui/field';
import { InlineConfirm } from '../components/ui/inline-confirm';
import { PasswordField } from '../components/ui/password-field';
import { StackCapabilityNote, useStackCapability } from './stackCapabilities';
import { Input } from '../components/ui/input';

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
    id: 'mac',
    label: 'Calendars on this Mac',
    hint: 'No password. iCloud, Google, Microsoft 365 and other accounts in System Settings',
    defaultName: 'This Mac',
    userLabel: '',
    passwordLabel: '',
    needsServer: false,
  },
  {
    id: 'icloud',
    label: 'iCloud',
    hint: 'Needs an app-specific password',
    defaultName: 'Personal',
    userLabel: 'Apple Account email',
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

const UNSAFE_PASSWORD = /[\s'"\\#$]/;

const stepLabels = (agentName: string): Array<{ step: CalendarProgressStep; label: string }> => [
  { step: 'saving', label: 'Checked and saved the sign-in' },
  { step: 'access', label: 'Gave the agents access' },
  { step: 'checking', label: `Checking ${agentName} can read it` },
];

const ACCESS_LEVELS: Array<{ level: CalendarAccess; label: string }> = [
  { level: 'off', label: 'Off' },
  { level: 'read', label: 'Read' },
  { level: 'change', label: 'Read and change' },
];

/** Why a provider usually stops accepting a password that used to work. */
const BROKEN_CAUSE: Record<CalendarProvider, string> = {
  icloud: 'This usually happens after an Apple Account password change, which cancels every app-specific password.',
  fastmail: 'This usually means the app password was revoked in Fastmail’s Privacy & Security settings.',
  nextcloud: 'This usually means the app password was revoked under Devices & sessions in Nextcloud.',
  other: 'This usually means the password was changed on the server.',
  mac: 'This usually means calendar access was turned off in System Settings.',
};

function providerOf(id: CalendarProvider): ProviderOption {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[4];
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
  | { mode: 'password'; account: CalendarAccountView }
  | { mode: 'calendars'; account: CalendarAccountView };

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
    : [builtinAgent(agents)];

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
            {APP_NAME} connects over CalDAV, which iCloud, Fastmail and Nextcloud all support. Each agent
            gets only the calendars you give it.
          </InfoTip>
        </p>
        <span className="wb-vault-grow" />
        {accounts.length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            className="gap-1.5"
            disabled={Boolean(working)}
            onClick={() => setSheet({ mode: 'connect' })}
          >
            <Plus size={14} aria-hidden="true" />
            Connect another calendar
          </Button>
        ) : null}
      </div>

      {loadError ? (
        <RetryCallout message={loadError} onRetry={() => void refresh()} />
      ) : loading ? (
        <p className="wb-settings-hint">Loading calendars…</p>
      ) : accounts.length === 0 && !working ? (
        <div className="wb-vault-list wb-vault-empty">
          <h3>No calendars connected</h3>
          <Button type="button" className="gap-1.5" onClick={() => setSheet({ mode: 'connect' })}>
            <Plus size={14} aria-hidden="true" />
            Connect calendar
          </Button>
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
              sheetOpen={Boolean(sheet)}
              onChangeAccess={() => setSheet({ mode: 'access', account })}
              onReplacePassword={() => setSheet({ mode: 'password', account })}
              onEditCalendars={() => setSheet({ mode: 'calendars', account })}
              onChanged={(message) => {
                setToast(message);
                void refresh();
              }}
            />
          ))}
        </div>
      )}

      {sheet?.mode === 'calendars' ? (
        <MacCalendarsSheet
          account={sheet.account}
          onCancel={() => setSheet(null)}
          onSaved={(account) => finished(account, 'Saved the calendars agents can see')}
        />
      ) : sheet ? (
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
  sheetOpen,
  onChangeAccess,
  onReplacePassword,
  onEditCalendars,
  onChanged,
}: {
  account: CalendarAccountView;
  agents: AgentProfile[];
  working: CalendarProgressStep | null;
  note: string | null;
  /** A sheet is open over the panel, so Escape belongs to it. */
  sheetOpen: boolean;
  onChangeAccess: () => void;
  onReplacePassword: () => void;
  onEditCalendars: () => void;
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState<'test' | 'remove' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = providerOf(account.provider);
  const isMac = account.provider === 'mac';
  const mac = useMacStatus(isMac);
  const hostCallbacks = useStackCapability('hostCallbacks');
  // The Mac card follows the helper's live answer (re-checked on focus) once it has one.
  const live = isMac ? macCardState(mac.status) : null;
  const check = account.lastCheck;
  const tone = working
    ? 'is-busy'
    : live
      ? live.tone
      : check?.status === 'rejected'
        ? 'is-bad'
        : check?.status === 'unreachable'
          ? 'is-warn'
          : 'is-ok';
  const pill = working
    ? 'Connecting'
    : live
      ? live.pill
      : check?.status === 'rejected'
      ? isMac
        ? 'Access off'
        : 'Sign-in failed'
      : check?.status === 'unreachable'
        ? 'Unreachable'
        : 'Connected';
  const withAccess = agents.filter((a) => (account.access[a.slug] ?? 'off') !== 'off');
  const broken = !isMac && check?.status === 'rejected' && !working;
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
        <Callout variant="destructive" layout="row" size="sm" className="wb-inference-callout" role="alert">
          <p>
            {provider.label} stopped accepting this password
            {shortDate(check?.at) ? ` on ${shortDate(check?.at)}` : ''}. Agents can’t use{' '}
            {account.name} until you replace it.
          </p>
          <p>{BROKEN_CAUSE[account.provider]}</p>
        </Callout>
      ) : null}
      {!isMac && check?.status === 'unreachable' && !working ? (
        <Callout variant="warn" layout="row" size="sm" className="wb-inference-callout" role="alert">
          <p>The last test couldn’t reach {provider.label}. {check.error}</p>
        </Callout>
      ) : null}

      {working ? (
        <ProgressList step={working} />
      ) : isMac && !hostCallbacks ? (
        <StackCapabilityNote capability="hostCallbacks" size="sm" />
      ) : isMac ? (
        <MacCardDetails account={account} agents={agents} mac={mac} />
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
        <InlineConfirm
          label={`Remove ${account.name}`}
          confirmLabel={busy === 'remove' ? 'Removing…' : `Remove ${account.name}`}
          busy={busy === 'remove'}
          escapeDisabled={sheetOpen}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
        >
          Remove {account.name}? Agents lose access to it right away. Your calendar and its events
          stay as they are.
          {account.provider === 'icloud'
            ? ' You can also revoke the app-specific password at account.apple.com.'
            : ''}
        </InlineConfirm>
      ) : working ? null : (
        <div className="wb-inference-actions">
          {broken ? (
            <Button type="button" disabled={Boolean(busy)} onClick={onReplacePassword}>
              Replace password
            </Button>
          ) : (
            <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={() => void test()}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
          )}
          {isMac ? (
            <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={onEditCalendars}>
              Edit calendars
            </Button>
          ) : null}
          <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={onChangeAccess}>
            Change access
          </Button>
          {broken || isMac ? null : (
            <Button type="button" variant="secondary" disabled={Boolean(busy)} onClick={onReplacePassword}>
              Replace password
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            disabled={Boolean(busy)}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Remove
          </Button>
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

/** What a new account's saved message says about the built-in agent's access. */
function accessSentence(access: CalendarAccess | undefined, agentName: string): string {
  if (access === 'change') return `. ${agentName} can read it and asks before changes.`;
  if (access === 'read') return `. ${agentName} can read it.`;
  return '.';
}

function ProgressList({ step }: { step: CalendarProgressStep }) {
  const agentName = useBuiltinAgentName();
  const labels = stepLabels(agentName);
  const at = labels.findIndex((s) => s.step === step);
  return (
    <ul className="wb-cal-progress" aria-live="polite">
      {labels.map((s, i) => {
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
  const agentName = builtinAgentName(agents);
  const [step, setStep] = useState<1 | 2 | 3>(editing ? 3 : replacing ? 2 : 1);
  const hostCallbacks = useStackCapability('hostCallbacks');
  // Taken, or out of reach: the stack's containers can't call the Mac calendar helper here.
  const macUnavailable = takenSlugs.includes('mac') || !hostCallbacks;
  // Calendars on this Mac needs no password, so it is the default until a Mac account exists.
  const [provider, setProvider] = useState<CalendarProvider>(replacing?.provider ?? (macUnavailable ? 'icloud' : 'mac'));
  const [server, setServer] = useState(replacing?.url ?? '');
  const [username, setUsername] = useState(replacing?.username ?? '');
  const [password, setPassword] = useState('');
  const [walkthrough, setWalkthrough] = useState(false);
  const [macCalendars, setMacCalendars] = useState<MacCalendarSummary[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const grantedMac = useCallback((calendars: MacCalendarSummary[]) => {
    setMacCalendars(calendars);
    setTicked(defaultTicked(calendars));
  }, []);
  const [name, setName] = useState(() => providerOf(provider).defaultName);
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

  // Start caldav-mcp once a CalDAV provider is chosen: the first start builds it, which overlaps
  // with the rest of the sheet. Calendars on this Mac doesn't use it.
  const needsCalDav = !editing && provider !== 'mac';
  useEffect(() => {
    if (!needsCalDav || servicePromise.current) return;
    const p = window.electronAPI.calendars
      .prepare()
      .then((r): ServiceState => (r.success ? { kind: 'ready' } : { kind: 'failed', error: r.error ?? 'The calendar service didn’t start.' }))
      .catch((): ServiceState => ({ kind: 'failed', error: 'The calendar service didn’t start.' }));
    servicePromise.current = p;
    void p.then(setService);
  }, [needsCalDav]);

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
    ? `${APP_NAME} can’t pass on a password with spaces, quotes, backslashes, # or $. Create an app password for ${APP_NAME} instead.`
    : null;
  const ready = Boolean(username.trim() && password && !passwordProblem && !nameProblem && (!option.needsServer || server.trim()));

  const providerName = useId();
  const pickProvider = (id: CalendarProvider) => {
    setProvider(id);
    setServer('');
    setTest(null);
    if (!nameTouched) setName(providerOf(id).defaultName);
  };

  // Opened from the chat before the account list loaded: a Mac account turned up, so the provider
  // step can't offer Calendars on this Mac any more.
  useEffect(() => {
    if (macUnavailable && step === 1 && provider === 'mac') {
      setProvider('icloud');
      if (!nameTouched) setName(providerOf('icloud').defaultName);
    }
  }, [macUnavailable, step, provider, nameTouched]);

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
      if (provider === 'mac' && !replacing && !editing) {
        const result = await window.electronAPI.calendars.macConnect({ allowedCalendarIds: ticked, access });
        if (!result.success && !result.account) {
          setError(result.error ?? 'Couldn’t connect the calendars on this Mac.');
          return;
        }
        const agentAccess = result.account?.access[BUILTIN_ASSISTANT_SLUG];
        onDone(
          result.account,
          result.success
            ? `This Mac connected${accessSentence(agentAccess, agentName)}`
            : 'This Mac saved',
          result.error
        );
        return;
      }
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
      const agentAccess = result.account?.access[BUILTIN_ASSISTANT_SLUG];
      onDone(
        result.account,
        `${name.trim()} connected${
          accessSentence(agentAccess, agentName)
        }`,
        result.error
      );
    });

  const shownName = editing
    ? editing.name
    : replacing
      ? replacing.name
      : provider === 'mac'
        ? 'This Mac'
        : name.trim() || 'this calendar';
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
      {walkthrough ? (
        <AppPasswordWalkthrough
          titleId="wb-cal-sheet-title"
          initialPassword={password}
          onUseMac={
            replacing || macUnavailable
              ? undefined
              : () => {
                  setWalkthrough(false);
                  pickProvider('mac');
                  setStep(2);
                }
          }
          onClose={() => setWalkthrough(false)}
          onDone={(value) => {
            if (value) {
              setPassword(value);
              setTest(null);
            }
            setWalkthrough(false);
          }}
        />
      ) : null}
      {walkthrough ? null : step === 1 ? (
        <>
          <h2 id="wb-cal-sheet-title">Where is your calendar?</h2>
          <p className="wb-sheet-lede">You can connect more than one. Each shows up in chat under its own name.</p>
          <ChoiceGroup kind="radio" aria-label="Provider">
            {PROVIDERS.filter((p) => !(p.id === 'mac' && macUnavailable)).map((p) => (
              <ChoiceRow
                key={p.id}
                variant="card"
                control={<Radio name={providerName} checked={provider === p.id} onChange={() => pickProvider(p.id)} />}
                title={p.label}
                description={p.id === 'icloud' && !macUnavailable ? 'Needs an app-specific password, or use Calendars on this Mac' : p.hint}
              />
            ))}
          </ChoiceGroup>
          {hostCallbacks ? null : <StackCapabilityNote capability="hostCallbacks" size="sm" />}
          <h3 className="wb-vault-label">Not supported yet</h3>
          <ul className="wb-cal-unsupported">
            <li>
              <UnsupportedItem
                title="Google Calendar."
                reason={`Google’s CalDAV needs a Google sign-in, which ${APP_NAME} can’t do yet.`}
                onUseMac={macUnavailable ? null : () => pickProvider('mac')}
              />
            </li>
            <li>
              <UnsupportedItem
                title="Outlook and Microsoft 365."
                reason="Microsoft doesn’t offer CalDAV."
                onUseMac={macUnavailable ? null : () => pickProvider('mac')}
              />
            </li>
          </ul>
        </>
      ) : null}

      {!walkthrough && step === 2 && provider === 'mac' ? (
        <>
          {macCalendars ? (
            <>
              <h2 id="wb-cal-sheet-title">Which calendars can agents see?</h2>
              <p className="wb-sheet-lede">Agents you choose will see the events in the calendars you tick.</p>
              <MacChooseStep calendars={macCalendars} ticked={ticked} onChange={setTicked} />
            </>
          ) : (
            <MacAllowStep titleId="wb-cal-sheet-title" onGranted={grantedMac} />
          )}
          <div className="wb-sheet-actions wb-vault-sheet-actions">
            <Button type="button" variant="secondary" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button type="button" disabled={ticked.length === 0} onClick={() => setStep(3)}>
              Continue
            </Button>
          </div>
        </>
      ) : null}

      {!walkthrough && step === 2 && provider !== 'mac' ? (
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
              ? 'iCloud only accepts an app-specific password here. Your Apple Account password won’t work.'
              : 'Use an app password if your provider offers one, so you can revoke it without changing your main password.'}
          </p>
          <SignInHelp provider={provider} onShowWalkthrough={() => setWalkthrough(true)} />

          {option.needsServer && !replacing ? (
            <Field label="Server address" htmlFor="wb-cal-server">
              <Input
                id="wb-cal-server"
                className="font-mono"
                value={server}
                autoComplete="off"
                placeholder={provider === 'nextcloud' ? 'cloud.example.com' : 'dav.example.com'}
                onChange={(e) => {
                  setServer(e.target.value);
                  setTest(null);
                }}
              />
            </Field>
          ) : null}
          <Field label={option.userLabel} htmlFor="wb-cal-user">
            <Input
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
          </Field>
          <Field
            label={option.passwordLabel}
            htmlFor="wb-cal-password"
            hint={passwordProblem ? <span className="wb-sheet-error">{passwordProblem}</span> : undefined}
          >
            <PasswordField
              id="wb-cal-password"
              className="font-mono"
              autoFocus={Boolean(replacing)}
              value={password}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={provider === 'icloud' ? 'abcd-efgh-ijkl-mnop' : ''}
              onChange={(e) => {
                setPassword(e.target.value);
                setTest(null);
              }}
            />
          </Field>
          {replacing ? null : (
            <Field
              label="Name"
              htmlFor="wb-cal-name"
              hint={
                nameProblem ? (
                  <span className="wb-sheet-error">{nameProblem}</span>
                ) : (
                  `What you call it in chat: “check my ${name.trim()} calendar”.`
                )
              }
            >
              <Input
                id="wb-cal-name"
                value={name}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
              />
            </Field>
          )}
          {!option.needsServer && !replacing ? (
            <details className="wb-cal-advanced">
              <summary>Server address</summary>
              <Field
                label="CalDAV address"
                htmlFor="wb-cal-server-adv"
                hint="Change this only if your provider gave you a different address."
              >
                <Input
                  id="wb-cal-server-adv"
                  className="font-mono"
                  value={server}
                  autoComplete="off"
                  placeholder={PROVIDER_URL[provider]}
                  onChange={(e) => {
                    setServer(e.target.value);
                    setTest(null);
                  }}
                />
              </Field>
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
            <Button
              type="button"
              variant="secondary"
              disabled={testing || busy}
              onClick={() => (replacing ? onCancel() : setStep(1))}
            >
              {replacing ? 'Cancel' : 'Back'}
            </Button>
            {test?.status === 'ok' ? (
              <Button type="submit" disabled={busy}>
                {replacing ? (busy ? 'Saving…' : 'Save password') : 'Continue'}
              </Button>
            ) : (
              <Button type="submit" disabled={!ready || testing}>
                {testLabel}
              </Button>
            )}
          </div>
        </form>
      ) : null}

      {!walkthrough && step === 3 ? (
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
                  <span title={a.builtIn ? undefined : a.role}>
                    {a.builtIn ? 'Your main agent' : a.role}
                  </span>
                </span>
                <Segmented
                  size="sm"
                  aria-label={`${a.displayName} access`}
                  options={ACCESS_LEVELS.map(({ level, label }) => ({ value: level, label }))}
                  value={access[a.slug] ?? 'off'}
                  disabled={busy}
                  onChange={(level) => setAccess((prev) => ({ ...prev, [a.slug]: level }))}
                />
              </li>
            ))}
          </ul>
          {cloudProvider && anyAccess ? (
            <Callout variant="warn" layout="row" size="sm" className="wb-inference-callout" role={undefined}>
              <p>
                {cloudInferenceNotice(cloudProvider)} That includes event titles, notes and
                attendees.
              </p>
            </Callout>
          ) : null}
          {busy && working ? <ProgressList step={working} /> : null}
          {error ? <p className="wb-sheet-error">{error}</p> : null}
        </>
      ) : null}

      {step !== 2 ? (
        <div className="wb-sheet-actions wb-vault-sheet-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => (step === 3 && !editing ? setStep(2) : onCancel())}
          >
            {step === 3 && !editing ? 'Back' : 'Cancel'}
          </Button>
          {step === 1 ? (
            <Button type="button" onClick={() => setStep(2)}>
              Continue
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? (editing ? 'Saving…' : 'Connecting…') : editing ? 'Save' : 'Connect'}
            </Button>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}

function UnsupportedItem({ title, reason, onUseMac }: { title: string; reason: string; onUseMac: (() => void) | null }) {
  if (!onUseMac) {
    return (
      <>
        <b>{title}</b> {reason}
      </>
    );
  }
  return (
    <button type="button" className="wb-cal-unsupported-btn" onClick={onUseMac}>
      <b>{title}</b> {reason} <span className="wb-cal-unsupported-hint">Use Calendars on this Mac</span>
    </button>
  );
}

function SignInHelp({ provider, onShowWalkthrough }: { provider: CalendarProvider; onShowWalkthrough: () => void }) {
  if (provider === 'icloud') {
    return (
      <div className="wb-cal-help">
        <Button type="button" variant="secondary" onClick={onShowWalkthrough}>
          Show me how
        </Button>
        <p>Your Apple Account needs two-factor authentication turned on first.</p>
      </div>
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
          <li>Under Devices &amp; sessions, create an app password called “{APP_NAME}”.</li>
          <li>Paste it below with your server address.</li>
        </ol>
      </details>
    );
  }
  return (
    <details className="wb-cal-help">
      <summary>Which server address?</summary>
      <p>Use the CalDAV address your server shows, or its host name. {APP_NAME} looks for the calendar address from there.</p>
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
      <Callout variant="warn" layout="row" size="sm" className="wb-inference-callout" role="alert">
        <p>{APP_SPECIFIC_FORMAT_WARNING}</p>
        <Button type="button" variant="secondary" onClick={onTestAnyway}>
          Test anyway
        </Button>
      </Callout>
    );
  }
  if (result.status === 'rejected') {
    return (
      <Callout variant="destructive" layout="row" size="sm" className="wb-inference-callout" role="alert">
        <p>
          {providerLabel} didn’t accept this username and password. Check that you pasted the app
          password. If you changed your account password since you made it, make a new one.
        </p>
      </Callout>
    );
  }
  if (result.status === 'unreachable' || result.status === 'error') {
    return (
      <Callout variant="destructive" layout="row" size="sm" className="wb-inference-callout" role="alert">
        <p>
          {result.status === 'unreachable' ? `Couldn’t reach ${providerLabel}. ` : ''}
          {result.error}
        </p>
      </Callout>
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
