import React, { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { sinceFor, windowChoiceOf, type EmailWindowChoice } from '../../../shared/emailAccount';
import {
  isActualFailure,
  type ActualScriptFailure,
  type AddonId,
  type EmailAccount,
  type EmailOverview,
  type EmailSettingsInput,
} from '../../../shared/types/addons';
import { AddonPageTop, AddonSwitchPanel, ConfirmSheet, FitOrStackDown, RemoveDataSheet, ToolsAndUpdates } from './AddonDetailParts';
import { addonPageState, callIpc, switchAddon, useAddonActions, useRefreshOnOpen } from './addonPageActions';
import { EmailConnectSheet, type EmailConnectMode } from './EmailConnectSheet';
import { Panel } from './AddonPanel';
import { StoppedAddonCallout } from './AddonStoppedAlert';
import { EMAIL_ATTACHMENTS_LABEL, EMAIL_CONSENT, EMAIL_EVERYTHING_HINT, EMAIL_OFF_ROW, EMAIL_WINDOW_LABEL } from './emailCopy';
import { useAddonInstall, useAddonListing } from './useAddons';
import { clockTime, listingErrorText, refreshEmail, rowMessage, useEmailOverview } from './useEmail';

// Email's page (spec decisions 37 and 38): one row per account with the indexer's last word on
// it, the settings every account shares, Turn off, and Remove and delete data. `enable` and
// `disable` reload Hermes in place, so nothing here goes in the restart bar.

/** How often the page reads the indexer's log again while a pass is owed. */
const EMAIL_PASS_POLL_MS = 30_000;

const NEW_CHATS = 'New chats get the change.';
const DRAFTS_LABEL = 'Let agents save drafts (never sends)';
const REMOVE_DATA_TEXT =
  'This deletes the index, the drafts queue and the stored passwords. Nothing changes on your mail servers.';

type WindowChoice = EmailWindowChoice | 'date';
const WINDOW_CHOICES: WindowChoice[] = ['90d', '30d', '1y', 'all', 'date'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const displayName = (name: string) => (name.toUpperCase() === 'INBOX' ? 'Inbox' : name);

/** The names when there are two or fewer, else how many. */
function mailboxSummary(mailboxes: string[]): string {
  if (mailboxes.length === 0) return 'No mailboxes';
  if (mailboxes.length <= 2) return mailboxes.map(displayName).join(', ');
  return `${mailboxes.length} mailboxes`;
}

/** "1,204 messages in the index; last pass 09:05", or null before any pass and while Email is off. */
function totalsLine(o: EmailOverview | null): string | null {
  if (!o?.enabled || !o.lastPass) return null;
  const n = o.lastPass.inScope;
  const at = clockTime(o.lastPass.at);
  const count = `${n.toLocaleString()} ${n === 1 ? 'message' : 'messages'} in the index`;
  return at ? `${count}; last pass ${at}` : count;
}

/** A settings or removal failure as the page says it, with the stack's message when it gave one. */
function changeFailure(f: ActualScriptFailure, what: string): string {
  if (f.error === 'busy' || f.error === 'missing_settings') return listingErrorText(f, '');
  return f.message ? `Couldn’t ${what}: ${f.message}` : `Couldn’t ${what} (${f.error}).`;
}

const attentionStates: EmailAccount['state'][] = ['login_refused', 'unreachable', 'left_out'];

const AccountRow: React.FC<{
  account: EmailAccount;
  /** Email is on; while it's off, the row says so instead of a pass result. */
  enabled: boolean;
  busy: boolean;
  onMailboxes(): void;
  onPassword(): void;
  onRemove(): void;
}> = ({ account, enabled, busy, onMailboxes, onPassword, onRemove }) => {
  const message = enabled ? rowMessage(account) : EMAIL_OFF_ROW;
  const refused = enabled && account.state === 'login_refused';
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0" aria-label={account.slug}>
      <code className="font-mono text-xs text-fg">{account.slug}</code>
      <p className="text-xs text-fg-faint">{[account.address, account.host, mailboxSummary(account.mailboxes)].join(' · ')}</p>
      {message ? (
        <p className={enabled && attentionStates.includes(account.state) ? 'text-xs text-warn' : 'text-xs text-fg-muted'}>{message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant={refused ? 'primary' : 'secondary'} disabled={busy} onClick={onPassword}>
          Change password
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onMailboxes}>
          Mailboxes
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </li>
  );
};

/** How far back, attachment text and drafts, which apply to every account (decision 38). */
const SettingsCard: React.FC<{
  overview: EmailOverview;
  busy: boolean;
  onSave(next: EmailSettingsInput): void;
}> = ({ overview, busy, onSave }) => {
  const since = overview.since ?? sinceFor('90d', new Date());
  const stored = windowChoiceOf(since, new Date());
  const [choice, setChoice] = useState<WindowChoice>(stored);
  const [date, setDate] = useState(stored === 'date' ? since : '');
  // A broadcast with another window (from the sheet, or another window) moves the choice too.
  useEffect(() => {
    setChoice(stored);
    if (stored === 'date') setDate(since);
  }, [stored, since]);

  const save = (patch: Partial<EmailSettingsInput>) =>
    onSave({ since, attachments: overview.attachments, drafts: overview.drafts, ...patch });

  const pick = (next: WindowChoice) => {
    setChoice(next);
    if (next !== 'date') save({ since: sinceFor(next, new Date()) });
  };

  return (
    <Panel title="Settings" lead="These apply to every account.">
      <label className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
        How far back
        <select aria-label="How far back" value={choice} disabled={busy} onChange={(e) => pick(e.target.value as WindowChoice)}>
          {WINDOW_CHOICES.map((c) => (
            <option key={c} value={c}>
              {EMAIL_WINDOW_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      {choice === 'all' ? <p className="text-xs text-fg-faint">{EMAIL_EVERYTHING_HINT}</p> : null}
      {choice === 'date' ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            Starting from
            <input type="date" aria-label="Starting from" value={date} disabled={busy} onChange={(e) => setDate(e.target.value)} />
          </label>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !YMD.test(date) || date === since}
            onClick={() => save({ since: date })}
          >
            Save
          </Button>
        </div>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={overview.attachments}
          disabled={busy}
          onChange={(e) => save({ attachments: e.target.checked })}
        />
        <span className="text-fg">{EMAIL_ATTACHMENTS_LABEL}</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        {/* The stack writes the drafts flag only while Email is on, so the switch waits for it. */}
        <input
          type="checkbox"
          checked={overview.drafts}
          disabled={busy || !overview.enabled}
          onChange={(e) => save({ drafts: e.target.checked })}
        />
        <span className="text-fg">{DRAFTS_LABEL}</span>
      </label>
      <p className="text-xs text-fg-faint">
        A new window or attachment setting restarts the indexer. Agents save drafts to each account’s Drafts mailbox and never send them.
      </p>
    </Panel>
  );
};

type Dialog = { kind: 'off' } | { kind: 'remove' } | { kind: 'remove-account'; account: EmailAccount } | null;

export const EmailDetail: React.FC<{
  id: AddonId;
  onBack(): void;
  onServices?(): void;
  onInstallStarted(): void;
}> = ({ onBack, onServices, onInstallStarted }) => {
  const listing = useAddonListing('email');
  const install = useAddonInstall('email');
  const overview = useEmailOverview();
  const [sheet, setSheet] = useState<EmailConnectMode | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { busy, error, note, setNote, act } = useAddonActions('email', refreshEmail, () => setDialog(null));

  // Decision 37: read when the page opens and after a run ends; while a pass is owed, every 30 s.
  useRefreshOnOpen(install, refreshEmail);
  const owed = Boolean(overview?.passOwed);
  useEffect(() => {
    if (!owed) return;
    const timer = setInterval(() => void refreshEmail(), EMAIL_PASS_POLL_MS);
    return () => clearInterval(timer);
  }, [owed]);

  if (!listing) return null;
  const { entry } = listing;
  const accounts = overview?.accounts ?? [];
  const { running, down, on, canGet, pill } = addonPageState(listing, install);
  const locked = busy || running;
  const totals = totalsLine(overview);
  const showGet = !on && !running && accounts.length === 0;

  const saveSettings = (next: EmailSettingsInput) =>
    act(async () => {
      const reply = await callIpc(() => window.electronAPI.addons.email.setSettings(next), 'Couldn’t change the settings.');
      if (typeof reply === 'string') return reply;
      if (isActualFailure(reply.result)) return changeFailure(reply.result, 'change the settings');
      setNote(NEW_CHATS);
      return null;
    });

  const removeAccount = (account: EmailAccount) =>
    act(async () => {
      const reply = await callIpc(() => window.electronAPI.addons.email.removeAccount(account.slug), 'Couldn’t remove the account.');
      if (typeof reply === 'string') return reply;
      if (isActualFailure(reply.result)) return changeFailure(reply.result, `remove ${account.slug}`);
      setNote(`Removed ${account.slug} and its password. Its messages leave the index on the indexer’s next pass.`);
      return null;
    });

  const turnOff = () =>
    act(switchAddon('email', entry.name, false, () => setNote(`Email is off. Accounts, passwords and the index stay. ${NEW_CHATS}`)));
  const turnOn = () => act(switchAddon('email', entry.name, true, () => setNote(`Email is on. ${NEW_CHATS}`)));

  return (
    <div className="flex flex-col gap-5">
      <AddonPageTop {...{ entry, pill, running, onBack, onServices, error, note }} onShowProgress={onInstallStarted} />
      {overview?.readError ? <Callout variant="warn">{`Couldn’t read the accounts: ${overview.readError}`}</Callout> : null}

      {showGet ? (
        <Panel title="Let agents search your mail" lead={EMAIL_CONSENT[0]}>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!canGet} onClick={() => setSheet({ kind: 'first' })}>
              Get
            </Button>
          </div>
          <p className="text-xs text-fg-muted">Get asks for an account and its mailboxes, then turns Email on.</p>
        </Panel>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          {showGet ? <FitOrStackDown listing={listing} down={down} /> : null}
          {on && listing.stopped && !running ? <StoppedAddonCallout listing={listing} /> : null}

          {accounts.length || on ? (
            <Panel title="Accounts" lead={EMAIL_CONSENT[0]}>
              {accounts.length ? (
                <ul className="flex flex-col">
                  {accounts.map((account) => (
                    <AccountRow
                      key={account.slug}
                      account={account}
                      enabled={Boolean(overview?.enabled)}
                      busy={locked}
                      onMailboxes={() => setSheet({ kind: 'mailboxes', account })}
                      onPassword={() => setSheet({ kind: 'password', account })}
                      onRemove={() => setDialog({ kind: 'remove-account', account })}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-fg-muted">No account yet. Email indexes nothing until you add one.</p>
              )}
              {totals ? <p className="text-xs text-fg-muted">{totals}</p> : null}
              <div>
                <Button type="button" size="sm" variant="secondary" disabled={locked} onClick={() => setSheet({ kind: 'add' })}>
                  Add account
                </Button>
              </div>
            </Panel>
          ) : null}

          {overview && (accounts.length || on) ? <SettingsCard overview={overview} busy={locked} onSave={(next) => void saveSettings(next)} /> : null}

          {on || accounts.length ? (
            <AddonSwitchPanel
              onTurnOn={() => void turnOn()}
              onTurnOff={() => void turnOff()}
              onDialog={(kind) => setDialog(kind && { kind })}
              listing={listing}
              title="Email on this Mac"
              lead={
                on
                  ? 'Turning it off stops the indexer and takes the mail tools from new chats. Accounts, passwords and the index stay.'
                  : 'Off. Its accounts, passwords and index are still on this Mac.'
              }
              locked={locked}
              canTurnOn={canGet}
              offOpen={dialog?.kind === 'off'}
              busy={busy}
              offTitleId="email-off-title"
              offTitle="Turn off Email?"
              offText="The indexer stops and chats you start afterwards can’t search your mail. Chats already open keep their tools until they end. Accounts, passwords and the index stay."
            />
          ) : null}
        </div>
        <div className="flex flex-col gap-4">
          <ToolsAndUpdates entry={entry} />
        </div>
      </div>

      <ConfirmSheet
        open={dialog?.kind === 'remove-account'}
        busy={busy}
        titleId="email-remove-account-title"
        title={dialog?.kind === 'remove-account' ? `Remove ${dialog.account.slug}?` : ''}
        confirmLabel="Remove"
        busyLabel="Removing…"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.kind === 'remove-account') void removeAccount(dialog.account);
        }}
      >
        {dialog?.kind === 'remove-account'
          ? `The stack deletes the account and its password, then restarts the indexer, so its messages leave the index on that pass. Nothing changes on ${dialog.account.host}.`
          : ''}
      </ConfirmSheet>

      {dialog?.kind === 'remove' ? (
        <RemoveDataSheet id="email" installed={on} title="Remove Email and delete its data?" onClose={() => setDialog(null)} onStarted={onInstallStarted}>
          {REMOVE_DATA_TEXT}
        </RemoveDataSheet>
      ) : null}

      {sheet ? <EmailConnectSheet mode={sheet} onClose={() => setSheet(null)} /> : null}
    </div>
  );
};
