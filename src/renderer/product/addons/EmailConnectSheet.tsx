import React, { useEffect, useState } from 'react';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { cn } from '../../lib/utils';
import {
  EMAIL_PROVIDERS,
  OTHER_DEFAULT_SLUG,
  defaultMailboxes,
  isEmailSlug,
  plainAllowed,
  sinceFor,
  windowChoiceOf,
  type EmailWindowChoice,
} from '../../../shared/emailAccount';
import {
  isActualFailure,
  type ActualScriptFailure,
  type EmailAccount,
  type EmailAccountInput,
  type EmailMailbox,
  type EmailProviderId,
  type EmailSecurity,
} from '../../../shared/types/addons';
import { AppPasswordWalkthrough } from '../calendar/AppPasswordWalkthrough';
import {
  EMAIL_ATTACHMENTS_LABEL,
  EMAIL_CHOOSE_ACCOUNT,
  EMAIL_CONSENT,
  EMAIL_EVERYTHING_HINT,
  EMAIL_PREPARING,
  EMAIL_PROTON_UNTESTED,
  EMAIL_PROVIDER_LABEL,
  EMAIL_SECURITY_LABEL,
  EMAIL_SETTINGS_SET,
  EMAIL_SLUG_RULE,
  EMAIL_WINDOW_LABEL,
} from './emailCopy';
import { startEmailInstall } from './useAddons';
import { listingErrorText, refreshEmail, useEmailOverview } from './useEmail';

// Connect an email account (spec decisions 33 to 36): consent before the first account, a
// provider, the account with its login checked by listing mailboxes, then mailboxes and how far
// back. The password lives in this form only until `email-save-account` answers; main writes it
// to `addon.sh configure`'s stdin and keeps nothing. Closing the sheet unmounts the form.

export type EmailConnectMode =
  | { kind: 'first' }
  | { kind: 'add' }
  | { kind: 'password'; account: EmailAccount }
  | { kind: 'mailboxes'; account: EmailAccount };

type Step = 'consent' | 'account' | 'mailboxes';
type KnownProvider = Exclude<EmailProviderId, 'other'>;
type WindowChoice = EmailWindowChoice | 'date';

const PROVIDER_IDS: EmailProviderId[] = ['icloud', 'gmail', 'fastmail', 'yahoo', 'other'];
const WINDOW_CHOICES: WindowChoice[] = ['90d', '30d', '1y', 'all', 'date'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const NO_ANSWER = 'Boundary’s add-on service didn’t answer.';

function providerOf(host: string): EmailProviderId {
  return (Object.keys(EMAIL_PROVIDERS) as KnownProvider[]).find((id) => EMAIL_PROVIDERS[id].host === host) ?? 'other';
}

const displayName = (name: string) => (name.toUpperCase() === 'INBOX' ? 'Inbox' : name);

/** An IPC reply's failure as the sheet says it, or null when it worked. */
function replyFailure(
  reply: { success: boolean; error?: string; result?: { ok: true } | ActualScriptFailure },
  host: string
): string | null {
  if (!reply.success) return reply.error ?? NO_ANSWER;
  if (reply.result && isActualFailure(reply.result)) return listingErrorText(reply.result, host);
  return null;
}

const ConnectForm: React.FC<{ mode: EmailConnectMode; onClose(): void; onStarted?(): void }> = ({
  mode,
  onClose,
  onStarted,
}) => {
  const overview = useEmailOverview();
  const existing = mode.kind === 'password' || mode.kind === 'mailboxes' ? mode.account : null;

  const [step, setStep] = useState<Step>(mode.kind === 'first' ? 'consent' : mode.kind === 'mailboxes' ? 'mailboxes' : 'account');
  const [provider, setProvider] = useState<EmailProviderId | null>(existing ? providerOf(existing.host) : null);
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? 993));
  const [security, setSecurity] = useState<EmailSecurity>(existing?.security ?? 'tls');
  const [user, setUser] = useState(existing?.user ?? '');
  const [address, setAddress] = useState(existing?.address ?? '');
  const [password, setPassword] = useState('');
  const [walkthrough, setWalkthrough] = useState(false);
  /** The new account's name once `configure` stored it, so Cancel can remove it. */
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  /** Connect stored the new account's mailboxes, so `remove-new` would skip it. */
  const [mailboxesStored, setMailboxesStored] = useState(false);
  const [mailboxes, setMailboxes] = useState<EmailMailbox[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>('90d');
  const [date, setDate] = useState('');
  const [attachments, setAttachments] = useState(false);
  const [busy, setBusy] = useState<'listing' | 'connecting' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const known = provider !== null && provider !== 'other' ? EMAIL_PROVIDERS[provider] : null;
  const hostValue = known ? known.host : host.trim();
  const portValue = known ? known.port : Number(port);
  const securityValue: EmailSecurity = known ? known.security : security === 'plain' && !plainAllowed(hostValue) ? 'tls' : security;
  // A known provider's user name is the address, except for a stored account, which keeps its own.
  const userValue = known ? (existing ? existing.user : address.trim()) : user.trim();
  const slugOk = isEmailSlug(slug);
  const taken = !existing && slug !== savedSlug && Boolean(overview?.accounts.some((a) => a.slug === slug));
  const passwordKept = existing !== null || (savedSlug !== null && savedSlug === slug);
  const accountReady =
    provider !== null &&
    slugOk &&
    !taken &&
    /^\S+$/.test(hostValue) &&
    Number.isInteger(portValue) &&
    portValue > 0 &&
    portValue < 65536 &&
    userValue !== '' &&
    address.includes('@') &&
    (password !== '' || passwordKept);

  // Until the overview loads, the stored window and drafts are unknown, so Connect waits.
  const windowSet = Boolean(overview?.since);
  const since = windowChoice === 'date' ? date : sinceFor(windowChoice, new Date());
  const mailboxesReady = overview !== null && chosen.length > 0 && (windowSet || YMD.test(since));

  const edited = () => setFailure(null);

  const showList = (list: EmailMailbox[]) => {
    // The stack lists only mailboxes that can be selected.
    setMailboxes(list);
    const stored = existing?.mailboxes ?? [];
    setChosen(stored.length ? stored : defaultMailboxes(list));
    setStep('mailboxes');
  };

  const listMailboxes = async (name: string, at: string): Promise<void> => {
    const reply = await window.electronAPI.addons.email.mailboxes(name);
    if (!reply.success) {
      setFailure(reply.error ?? NO_ANSWER);
      return;
    }
    if (isActualFailure(reply.result)) {
      setFailure(listingErrorText(reply.result, at));
      return;
    }
    showList(reply.result.mailboxes);
  };

  // The Mailboxes button on a row opens straight at this step, so list them now. Keyed on the
  // slug: an overview broadcast hands the parent a new account object, which mustn't re-list.
  const listSlug = mode.kind === 'mailboxes' ? mode.account.slug : null;
  const listHost = mode.kind === 'mailboxes' ? mode.account.host : '';
  const listStored = () => {
    if (!listSlug) return;
    setBusy('listing');
    setFailure(null);
    listMailboxes(listSlug, listHost)
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  useEffect(listStored, [listSlug]);

  const next = async () => {
    if (!accountReady) return;
    setBusy('listing');
    setFailure(null);
    try {
      if (!existing && savedSlug !== null && savedSlug !== slug) {
        // A new name: the account stored under the old one has no mailboxes, so it goes.
        await window.electronAPI.addons.email.cancelAccount(savedSlug).catch((): void => undefined);
        setSavedSlug(null);
      }
      const input: EmailAccountInput = {
        slug,
        host: hostValue,
        port: portValue,
        security: securityValue,
        user: userValue,
        address: address.trim(),
        password: password === '' ? null : password,
      };
      let reply;
      try {
        reply = await window.electronAPI.addons.email.saveAccount(input);
      } finally {
        setPassword('');
      }
      const failed = replyFailure(reply, hostValue);
      if (failed) {
        setFailure(failed);
        return;
      }
      if (!existing) setSavedSlug(slug);
      await listMailboxes(slug, hostValue);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!mailboxes || !mailboxesReady) return;
    setBusy('connecting');
    setFailure(null);
    const account = existing?.slug ?? slug;
    const at = existing?.host ?? hostValue;
    try {
      const picked = mailboxes.filter((m) => chosen.includes(m.name)).map((m) => m.name);
      let failed = replyFailure(await window.electronAPI.addons.email.setMailboxes(account, picked), at);
      if (!failed && !existing) setMailboxesStored(true);
      if (!failed && !windowSet) {
        failed = replyFailure(
          await window.electronAPI.addons.email.setSettings({ since, attachments, drafts: overview?.drafts ?? false }),
          at
        );
      }
      if (failed) {
        setFailure(failed);
        return;
      }
      onClose();
      if (mode.kind === 'first') {
        startEmailInstall(account);
        onStarted?.();
      } else void refreshEmail();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Cancel, Escape and the backdrop: a new account isn't left stored. Once Connect stored its
   * mailboxes (and then failed), `remove-new` skips it, so it goes through Remove instead. The
   * page reads the accounts again afterwards, so the name is free for the next account.
   */
  const cancel = () => {
    if (!existing && savedSlug !== null) {
      const email = window.electronAPI.addons.email;
      const removal = mailboxesStored ? email.removeAccount(savedSlug) : email.cancelAccount(savedSlug);
      void removal.catch((): void => undefined).then(refreshEmail);
    }
    onClose();
  };

  const pickProvider = (id: EmailProviderId) => {
    setProvider(id);
    if (!existing) setSlug(id === 'other' ? OTHER_DEFAULT_SLUG : EMAIL_PROVIDERS[id].slug);
    edited();
  };

  /** The address field: Email address for a known provider, From address for Other. */
  const addressField = (label: string) => (
    <Field label={label} htmlFor="email-connect-address">
      <input
        id="email-connect-address"
        type="email"
        value={address}
        placeholder="you@example.com"
        disabled={busy !== null}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setAddress(e.target.value);
          edited();
        }}
      />
    </Field>
  );

  const openHelp = (url: string): void => {
    window.electronAPI.urls.openUrl(url).catch((): void => undefined);
  };

  const title =
    mode.kind === 'password'
      ? `Change the password for ${mode.account.slug}`
      : mode.kind === 'mailboxes'
        ? `Mailboxes for ${mode.account.slug}`
        : 'Add an email account';

  const actions =
    step === 'consent' ? (
      <SheetConfirmActions onCancel={cancel} confirmLabel={EMAIL_CHOOSE_ACCOUNT} onConfirm={() => setStep('account')} />
    ) : step === 'account' ? (
      <SheetConfirmActions
        busy={busy !== null}
        onCancel={cancel}
        confirmLabel="Next"
        confirmDisabled={!accountReady}
        onConfirm={() => void next()}
      />
    ) : (
      <SheetConfirmActions
        busy={busy !== null}
        onCancel={cancel}
        confirmLabel={busy === 'connecting' ? 'Saving…' : existing ? 'Save' : 'Connect'}
        confirmDisabled={!mailboxes || !mailboxesReady}
        onConfirm={() => void connect()}
      />
    );

  return (
    <Sheet
      open
      onClose={cancel}
      busy={busy !== null}
      titleId="email-connect-title"
      title={walkthrough ? undefined : title}
      className="wb-sheet-wide"
      actions={walkthrough ? undefined : actions}
    >
      {walkthrough ? (
        <AppPasswordWalkthrough
          titleId="email-connect-title"
          initialPassword={password}
          onDone={(pasted) => {
            setPassword(pasted);
            setWalkthrough(false);
            edited();
          }}
          onClose={() => setWalkthrough(false)}
        />
      ) : step === 'consent' ? (
        <ul className="mb-3.5 flex list-disc flex-col gap-2 pl-5 text-ui text-fg">
          {EMAIL_CONSENT.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : step === 'account' ? (
        <>
          <div role="group" aria-label="Provider" className="mb-3.5 flex flex-wrap gap-2">
            {PROVIDER_IDS.map((id) => (
              <Button
                key={id}
                variant={provider === id ? 'primary' : 'secondary'}
                aria-pressed={provider === id}
                disabled={busy !== null || (existing !== null && provider !== id)}
                onClick={() => pickProvider(id)}
              >
                {EMAIL_PROVIDER_LABEL[id]}
              </Button>
            ))}
          </div>

          {known && provider ? (
            <>
              {provider === 'icloud' ? (
                <p className="mb-3 text-xs text-fg-muted">
                  {'iCloud needs an app-specific password, not your Apple Account password. '}
                  <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => setWalkthrough(true)}>
                    Show me how
                  </button>
                </p>
              ) : (
                <div className="mb-3 text-xs text-fg-muted">
                  <p className="mb-1">{`${known.name} needs an app password, not your account password.`}</p>
                  <ol className="mb-1 list-decimal pl-5">
                    {known.steps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                  <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => openHelp(known.helpUrl)}>
                    {`Open ${EMAIL_PROVIDER_LABEL[provider]}’s help page`}
                  </button>
                </div>
              )}
              {addressField('Email address')}
            </>
          ) : provider === 'other' ? (
            <>
              <Field label="Server" htmlFor="email-connect-host">
                <input
                  id="email-connect-host"
                  value={host}
                  placeholder="imap.example.com"
                  disabled={busy !== null}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setHost(e.target.value.trim());
                    edited();
                  }}
                />
              </Field>
              <div className="wb-fields-inline">
                <Field label="Port" htmlFor="email-connect-port">
                  <input
                    id="email-connect-port"
                    inputMode="numeric"
                    value={port}
                    disabled={busy !== null}
                    autoComplete="off"
                    onChange={(e) => {
                      setPort(e.target.value.trim());
                      edited();
                    }}
                  />
                </Field>
                <Field label="Security" htmlFor="email-connect-security">
                  <select
                    id="email-connect-security"
                    value={securityValue}
                    disabled={busy !== null}
                    onChange={(e) => {
                      setSecurity(e.target.value as EmailSecurity);
                      edited();
                    }}
                  >
                    {(plainAllowed(hostValue) ? (['tls', 'starttls', 'plain'] as const) : (['tls', 'starttls'] as const)).map((s) => (
                      <option key={s} value={s}>
                        {EMAIL_SECURITY_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {plainAllowed(hostValue) ? <p className="mb-3 text-xs text-fg-muted">{EMAIL_PROTON_UNTESTED}</p> : null}
              <Field label="User name" htmlFor="email-connect-user">
                <input
                  id="email-connect-user"
                  value={user}
                  disabled={busy !== null}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setUser(e.target.value);
                    edited();
                  }}
                />
              </Field>
              {addressField('From address')}
            </>
          ) : null}

          {provider ? (
            <>
              <Field
                label={known ? 'App password' : 'Password'}
                htmlFor="email-connect-password"
                hint={passwordKept && password === '' ? 'Leave it empty to keep the password the stack has.' : undefined}
              >
                <input
                  id="email-connect-password"
                  type="password"
                  value={password}
                  disabled={busy !== null}
                  autoComplete="off"
                  onChange={(e) => {
                    setPassword(e.target.value);
                    edited();
                  }}
                />
              </Field>
              <Field
                label="Name agents use"
                htmlFor="email-connect-slug"
                hint={
                  slug && !slugOk ? (
                    <span className="text-danger">{EMAIL_SLUG_RULE}</span>
                  ) : taken ? (
                    <span className="text-danger">{`An account named ${slug} is already connected. Choose another name.`}</span>
                  ) : (
                    'Search results name the account by this.'
                  )
                }
              >
                <input
                  id="email-connect-slug"
                  className={cn('font-mono', slug && !slugOk && 'border-danger')}
                  value={slug}
                  disabled={busy !== null || existing !== null}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setSlug(e.target.value.trim());
                    edited();
                  }}
                />
              </Field>
            </>
          ) : null}
        </>
      ) : mailboxes ? (
        <>
          <div role="group" aria-label="Mailboxes" className="mb-3.5 flex flex-col gap-2">
            <span className="text-xs font-medium text-fg">Mailboxes</span>
            {mailboxes.map((m) => (
              <label key={m.name} className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={chosen.includes(m.name)}
                  disabled={busy !== null}
                  onChange={(e) => {
                    setChosen(e.target.checked ? [...chosen, m.name] : chosen.filter((n) => n !== m.name));
                    edited();
                  }}
                />
                <span className="text-fg">{displayName(m.name)}</span>
                {m.messages !== null ? <span className="text-fg-faint">{m.messages.toLocaleString('en-US')}</span> : null}
              </label>
            ))}
          </div>

          {windowSet && overview?.since ? (
            <div className="mb-3.5 flex flex-col gap-1 text-xs">
              <span className="font-medium text-fg">How far back</span>
              <span className="text-fg">
                {windowChoiceOf(overview.since, new Date()) === 'date'
                  ? `Since ${overview.since}`
                  : EMAIL_WINDOW_LABEL[windowChoiceOf(overview.since, new Date())]}
              </span>
              <span className="text-fg">{`${EMAIL_ATTACHMENTS_LABEL}: ${overview.attachments ? 'on' : 'off'}`}</span>
              <span className="text-fg-muted">{EMAIL_SETTINGS_SET}</span>
            </div>
          ) : (
            <>
              <div role="radiogroup" aria-label="How far back" className="mb-3.5 flex flex-col gap-2">
                <span className="text-xs font-medium text-fg">How far back</span>
                {WINDOW_CHOICES.map((choice) => (
                  <label key={choice} className="flex cursor-pointer items-start gap-2 text-xs">
                    <input
                      type="radio"
                      name="email-connect-window"
                      className="mt-0.5"
                      checked={windowChoice === choice}
                      disabled={busy !== null}
                      onChange={() => {
                        setWindowChoice(choice);
                        edited();
                      }}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-fg">{EMAIL_WINDOW_LABEL[choice]}</span>
                      {choice === 'all' && windowChoice === 'all' ? <span className="text-fg-muted">{EMAIL_EVERYTHING_HINT}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
              {windowChoice === 'date' ? (
                <Field label="Starting from" htmlFor="email-connect-since">
                  <input
                    id="email-connect-since"
                    type="date"
                    value={date}
                    disabled={busy !== null}
                    onChange={(e) => {
                      setDate(e.target.value);
                      edited();
                    }}
                  />
                </Field>
              ) : null}
              <label className="mb-3.5 flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={attachments}
                  disabled={busy !== null}
                  onChange={(e) => {
                    setAttachments(e.target.checked);
                    edited();
                  }}
                />
                <span className="text-fg">{EMAIL_ATTACHMENTS_LABEL}</span>
              </label>
            </>
          )}
        </>
      ) : null}

      {!walkthrough && busy === 'listing' ? <p className="mb-3 text-xs text-fg-muted">{EMAIL_PREPARING}</p> : null}
      {!walkthrough && failure ? <Callout variant="destructive">{failure}</Callout> : null}
      {listSlug && !mailboxes && failure && busy === null ? (
        <Button variant="secondary" className="mt-3" onClick={listStored}>
          Try again
        </Button>
      ) : null}
    </Sheet>
  );
};

/**
 * The email connect sheet; the parent mounts it only while open, so closing drops everything typed.
 * `onStarted` runs after a first connect starts the install, so the caller can show its steps.
 */
export const EmailConnectSheet: React.FC<{ mode: EmailConnectMode; onClose(): void; onStarted?(): void }> = ({
  mode,
  onClose,
  onStarted,
}) => (
  <ConnectForm mode={mode} onClose={onClose} onStarted={onStarted} />
);
