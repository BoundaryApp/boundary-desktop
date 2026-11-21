import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Pill } from '../../components/ui/badge';
import {
  isActualFailure,
  type AddonId,
  type BitwardenAccount,
  type BitwardenRequest,
} from '../../../shared/types/addons';
import { AddonPageColumns, AddonPageTop, AddonSwitchPanel, ConfirmSheet, RemoveDataSheet } from './AddonDetailParts';
import { addonPageState, callIpc, switchAddon, useAddonActions, useRefreshOnOpen } from './addonPageActions';
import { Panel } from './AddonPanel';
import { BitwardenConnectSheet } from './BitwardenConnectSheet';
import { BitwardenUnlockSheet } from './BitwardenUnlockSheet';
import {
  UNLOCK_LABEL,
  accountMessage,
  accountName,
  disconnectNote,
  isTerminalOnly,
  needsConnectAgain,
  needsUnlock,
  refreshBitwarden,
  scopeText,
  serverText,
  statePill,
  useBitwardenOverview,
} from './useBitwarden';
import {
  startAddonInstall,
  useAddonInstall,
  useAddonListing,
} from './useAddons';

// Bitwarden's page (spec decisions 26–32): one row per account from `vault.sh status`, the
// agent's pending requests from `requests --json` with Check now, and the logins it handed back
// that Bitwarden wouldn't move. Get turns the broker on and opens the connect sheet.

const WHERE_IT_WORKS =
  'The logins work in chats on your own profile and in the browser. Scheduled jobs and the API profile never get them.';

const SIGN_IN_BROWSER =
  'Bitwarden fills a login in a separate browser, so the password and two-step code never reach the agent. The agent’s browser then gets the site’s session.';

const IN_PAGE_FILL =
  'To have a login filled into the agent’s own page instead, add a custom field to that item in Bitwarden: name it agent-in-page-fill, choose Boolean, and check it.';

/** `created` (Unix seconds) as a short time for the request list. */
const when = (created: number): string =>
  created > 0 ? new Date(created * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

const AccountRow: React.FC<{
  account: BitwardenAccount;
  busy: boolean;
  onUnlock(): void;
  onLock(): void;
  onDisconnect(): void;
  onConnectAgain(): void;
}> = ({ account, busy, onUnlock, onLock, onDisconnect, onConnectAgain }) => {
  const pill = statePill(account);
  const message = accountMessage(account);
  const note = disconnectNote(account);
  const terminal = isTerminalOnly(account);
  const name = accountName(account);
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0" aria-label={name}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-fg">{name}</code>
        <Pill variant={pill.tone === 'danger' ? 'destructive' : pill.tone === 'muted' ? 'outline' : pill.tone} dot={pill.tone === 'ok'}>
          {pill.label}
        </Pill>
      </div>
      {account.state !== 'refused' ? (
        <p className="text-xs text-fg-faint">
          {[serverText(account), scopeText(account.scope), account.unlock ? UNLOCK_LABEL[account.unlock] : '']
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {message ? <p className={pill.tone === 'danger' || pill.tone === 'warn' ? 'text-xs text-warn' : 'text-xs text-fg-muted'}>{message}</p> : null}
      {terminal ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {needsConnectAgain(account) ? (
            <Button type="button" size="sm" disabled={busy} onClick={onConnectAgain}>
              Connect again
            </Button>
          ) : null}
          {needsUnlock(account) ? (
            <Button type="button" size="sm" disabled={busy} onClick={onUnlock}>
              Unlock
            </Button>
          ) : null}
          {account.unlock === 'manual' && account.state === 'unlocked' ? (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onLock}>
              Lock
            </Button>
          ) : null}
          {account.canDisconnect ? (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>
      )}
      {note ? <p className="text-xs text-fg-faint">{note}</p> : null}
    </li>
  );
};

const RequestRow: React.FC<{ request: BitwardenRequest; folderOf(account: string): string }> = ({ request, folderOf }) => (
  <li className="flex flex-col gap-1 border-t border-line py-3 first:border-t-0" aria-label={`Request for ${request.site}`}>
    <div className="flex flex-wrap items-center gap-2">
      <b className="text-xs font-medium text-fg">{request.site}</b>
      <span className="text-xs text-fg-faint">{`${request.account} · ${when(request.created)}`}</span>
    </div>
    {request.reason ? (
      <p className="text-xs text-fg-muted">
        {'The agent wrote: '}
        <q>{request.reason}</q>
      </p>
    ) : null}
    <p className="text-xs text-fg-muted">
      {`To allow it, move the login for ${request.site} into ${folderOf(request.account)} in any Bitwarden app, then press Check now.`}
    </p>
  </li>
);

/** The removal sheet's lede: the accounts the stack deletes, and those added at the terminal that stay. */
function removeLede(accounts: BitwardenAccount[]): string {
  const ours = accounts.filter((a) => a.canDisconnect);
  const kept = accounts.filter((a) => !a.canDisconnect && a.slug);
  return `The stack deletes ${ours.length ? `${ours.map(accountName).join(', ')} with ${ours.length === 1 ? 'its' : 'their'}` : 'the'} API keys, stored master passwords and Bitwarden data, then the broker’s data. Nothing in Bitwarden itself changes. Revoke the API keys there if you’re done with them.${
    kept.length ? ` ${kept.map(accountName).join(', ')} was added at the terminal and stays.` : ''
  }`;
}

type Dialog = { kind: 'off' } | { kind: 'remove' } | { kind: 'disconnect'; account: BitwardenAccount } | null;

export const BitwardenDetail: React.FC<{
  id: AddonId;
  onBack(): void;
  onServices?(): void;
  onInstallStarted(): void;
}> = ({ onBack, onServices, onInstallStarted }) => {
  const listing = useAddonListing('bitwarden');
  const install = useAddonInstall('bitwarden');
  const overview = useBitwardenOverview();
  const [connecting, setConnecting] = useState(false);
  // The refused account Connect again opened the sheet on, or null for a new account.
  const [reconnect, setReconnect] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { busy, error, note, setNote, act } = useAddonActions('bitwarden', refreshBitwarden, () => setDialog(null));
  const [checking, setChecking] = useState(false);
  const [syncLine, setSyncLine] = useState<string | null>(null);
  // Get opens the connect sheet once the broker is on (decision 26).
  const [sheetAfterGet, setSheetAfterGet] = useState(false);

  // Decision 27: read the state when the page opens, and again after a run ends.
  useRefreshOnOpen(install, refreshBitwarden, (run) => {
    if (sheetAfterGet && run.kind === 'install' && !run.error && !run.cancelled) setConnecting(true);
    setSheetAfterGet(false);
  });

  if (!listing) return null;
  const { entry } = listing;
  const accounts = overview?.accounts ?? [];
  const requests = overview?.requests ?? [];
  const { running, down, on, canGet, pill } = addonPageState(listing, install);
  const brokerDown = on && accounts.length > 0 && accounts.every((a) => a.error === 'broker_down');
  const unlocked = accounts.filter((a) => a.unlock === 'manual' && a.state === 'unlocked' && a.slug).map((a) => a.slug!);
  const folderOf = (slug: string) => {
    const scope = accounts.find((a) => a.slug === slug)?.scope;
    return scope?.startsWith('collection:') ? 'its collection' : scope?.startsWith('folder:') ? `the ${scope.slice(7)} folder` : 'its folder';
  };

  const get = () => {
    setSheetAfterGet(true);
    startAddonInstall('bitwarden');
  };

  const turnOff = () =>
    act(switchAddon('bitwarden', entry.name, false, () => setNote('Bitwarden is off. Its accounts stay connected and work again when you turn it on.')));
  const turnOn = () =>
    act(switchAddon('bitwarden', entry.name, true, () => setNote('Bitwarden is on. Chats you start now can use its logins.')));

  const disconnect = (account: BitwardenAccount) =>
    act(async () => {
      const reply = await callIpc(() => window.electronAPI.addons.bitwarden.disconnect(account.slug!), 'Couldn’t disconnect the account.');
      if (typeof reply === 'string') return reply;
      if (isActualFailure(reply.result)) return `Couldn’t disconnect ${account.slug} (${reply.result.error}). Press Disconnect again to finish.`;
      setNote(`${account.slug} is disconnected. ${reply.result.message}`.trim());
      return null;
    });

  const lock = (account: BitwardenAccount) =>
    act(async () => {
      const reply = await callIpc(() => window.electronAPI.addons.bitwarden.lock(account.slug!), 'Couldn’t lock the account.');
      if (typeof reply === 'string') return reply;
      return isActualFailure(reply.result) ? `Couldn’t lock ${account.slug} (${reply.result.error}).` : null;
    });

  const checkNow = async () => {
    setChecking(true);
    setSyncLine(null);
    const reply = await callIpc(() => window.electronAPI.addons.bitwarden.sync(), 'Couldn’t check Bitwarden.');
    setChecking(false);
    if (typeof reply === 'string') return setSyncLine(reply);
    const result = reply.result;
    if (isActualFailure(result)) {
      setSyncLine(
        result.error === 'busy'
          ? 'Bitwarden is already checking. Try again in a moment.'
          : result.error === 'broker_down'
            ? 'Bitwarden isn’t running. Turn it on again, or restart the assistant.'
            : `Couldn’t check Bitwarden (${result.error}).`
      );
      return;
    }
    if (result.recent) setSyncLine('Bitwarden checked less than 30 seconds ago, so this is that check’s result.');
    else setSyncLine(result.synced.length ? null : 'No account was unlocked to check. Unlock it, then press Check now.');
  };

  const showGet = !on && !running && accounts.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <AddonPageTop {...{ entry, pill, running, onBack, onServices, error, note }} onShowProgress={onInstallStarted} />
      {overview?.statusError ? <Callout variant="warn">{`Couldn’t read the accounts: ${overview.statusError}`}</Callout> : null}
      {brokerDown ? <Callout variant="warn">Bitwarden isn’t running, so every account is offline. Turn it on again, or restart the assistant.</Callout> : null}

      {showGet ? (
        <Panel title="Sign in with your Bitwarden logins" lead={`Connect a bitwarden.com account or your own server. ${WHERE_IT_WORKS}`}>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={!canGet} onClick={get}>
              Get
            </Button>
          </div>
          <p className="text-xs text-fg-muted">Get turns Bitwarden on, then asks for the account’s API key and a folder.</p>
        </Panel>
      ) : null}

      <AddonPageColumns
        listing={listing}
        down={down}
        showStopped={on && listing.stopped && !running}
        showFit={!on && !accounts.length && !running}
      >

          {requests.length ? (
            <Panel title="The agent is asking for logins" lead="Bitwarden decides: Boundary never says whether a matching login exists.">
              <ul className="flex flex-col">
                {requests.map((r) => (
                  <RequestRow key={r.requestId} request={r} folderOf={folderOf} />
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" disabled={busy || checking || running} onClick={() => void checkNow()}>
                  Check now
                </Button>
                {syncLine ? <span className="text-xs text-fg-muted">{syncLine}</span> : null}
              </div>
            </Panel>
          ) : null}

          {overview?.signInBrowser && (accounts.length || on) ? (
            <Panel title="How the agent signs in" lead={SIGN_IN_BROWSER}>
              <p className="text-xs text-fg-muted">{IN_PAGE_FILL}</p>
            </Panel>
          ) : null}

          {accounts.length || on ? (
            <Panel title="Accounts" lead={WHERE_IT_WORKS}>
              {accounts.length ? (
                <ul className="flex flex-col">
                  {accounts.map((account) => (
                    <AccountRow
                      key={account.slug ?? account.file ?? ''}
                      account={account}
                      busy={busy || running}
                      onUnlock={() => setUnlocking(account.slug)}
                      onLock={() => void lock(account)}
                      onDisconnect={() => setDialog({ kind: 'disconnect', account })}
                      onConnectAgain={() => {
                        setReconnect(account.slug);
                        setConnecting(true);
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-fg-muted">No account yet. Bitwarden does nothing until you connect one.</p>
              )}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy || running || !on}
                  onClick={() => {
                    setReconnect(null);
                    setConnecting(true);
                  }}
                >
                  Connect an account
                </Button>
              </div>
            </Panel>
          ) : null}

          {on || accounts.length ? (
            <AddonSwitchPanel
              listing={listing}
              title="Bitwarden on this Mac"
              lead={
                on
                  ? 'Turning it off stops the broker. Accounts stay connected and work again when you turn it on. Chats you start afterwards don’t get the logins.'
                  : 'Off. Its accounts are still connected.'
              }
              locked={busy || running}
              canTurnOn={canGet}
              offOpen={dialog?.kind === 'off'}
              busy={busy}
              offTitleId="bitwarden-off-title"
              offTitle="Turn off Bitwarden?"
              offText="The broker stops and chats you start afterwards don’t get the logins. Chats already open keep their tools until they end. Accounts stay connected."
              onDialog={(kind) => setDialog(kind && { kind })}
              onTurnOff={() => void turnOff()}
              onTurnOn={() => void turnOn()}
            />
          ) : null}

      </AddonPageColumns>

      <ConfirmSheet
        open={dialog?.kind === 'disconnect'}
        busy={busy}
        titleId="bitwarden-disconnect-title"
        title={dialog?.kind === 'disconnect' ? `Disconnect ${dialog.account.slug}?` : ''}
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.kind === 'disconnect') void disconnect(dialog.account);
        }}
      >
        {'The stack deletes the account’s API key, any stored master password and its Bitwarden data. Nothing in Bitwarden changes: revoke the API key there under Settings → Security → Keys if you’re done with it.'}
        {dialog?.kind === 'disconnect' && unlocked.some((s) => s !== dialog.account.slug)
          ? ` Disconnecting restarts Bitwarden, which locks ${unlocked.filter((s) => s !== dialog.account.slug).join(', ')}.`
          : ''}
      </ConfirmSheet>

      {dialog?.kind === 'remove' ? (
        <RemoveDataSheet
          id="bitwarden"
          installed={on}
          title="Remove Bitwarden and disconnect every account?"
          onClose={() => setDialog(null)}
          onStarted={onInstallStarted}
        >
          {removeLede(accounts)}
        </RemoveDataSheet>
      ) : null}

      <BitwardenConnectSheet
        open={connecting}
        existing={accounts.map((a) => a.slug).filter((s): s is string => s !== null)}
        reconnect={reconnect}
        unlocked={unlocked}
        onConnected={(message) => {
          setNote(message || 'Connected. Chats you start now can use its logins.');
          void refreshBitwarden();
        }}
        onClose={() => {
          setConnecting(false);
          setReconnect(null);
        }}
      />
      <BitwardenUnlockSheet slug={unlocking} onClose={() => setUnlocking(null)} />
    </div>
  );
};

