import React, { useState } from 'react';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/native-select';
import { Callout } from '../../components/ui/alert';
import { Pill } from '../../components/ui/badge';
import {
  isActualFailure,
  type ActualAccess,
  type ActualBudget,
  type AddonId,
} from '../../../shared/types/addons';
import { ACCESS_LABEL, addonPill, engineDown, hereFacts, inProgress, SETUP_WAYS } from './addonCopy';
import { ActualConnectSheet, type ActualConnectPreset } from './ActualConnectSheet';
import { Facts, SETUP_WAY_TITLE, SetupPath } from './addonFormParts';
import {
  AddonPageTop,
  AddonSwitchPanel,
  ConfirmSheet,
  FitOrStackDown,
  RemoveDataSheet,
  ToolsAndUpdates,
  WhatItRuns,
} from './AddonDetailParts';
import { callIpc, useAddonActions, useRefreshOnOpen } from './addonPageActions';
import { Panel } from './AddonPanel';
import { StoppedAddonCallout } from './AddonStoppedAlert';
import {
  budgetName,
  canSignInAgain,
  connectErrorText,
  hostOf,
  needsAttention,
  openActual,
  refreshActual,
  stateMessage,
  useActualOverview,
} from './useActual';
import { startAddonInstall, useAddonInstall, useAddonListing } from './useAddons';

// Actual Budget's page (spec decisions 18–24): one row per connected budget under the name agents
// use, Get for this Mac's server and Connect a budget for one the person already runs. Rows come
// from the stack's index; their sign-in state from `budget.sh status`, run when this page opens.

const PASSWORD_COPIED = 'Server password copied. Boundary clears it from the clipboard in 60 seconds.';

const BudgetRow: React.FC<{
  budget: ActualBudget;
  busy: boolean;
  onSignInAgain(): void;
  onDisconnect(): void;
  onAccess(access: ActualAccess): void;
  onMessage(line: string | null): void;
}> = ({ budget, busy, onSignInAgain, onDisconnect, onAccess, onMessage }) => {
  const message = stateMessage(budget);
  const attention = needsAttention(budget);
  return (
    <li className="flex flex-col gap-2 border-t border-line py-3 first:border-t-0" aria-label={budgetName(budget)}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-xs text-fg">{budgetName(budget)}</code>
        <span className="text-xs text-fg-faint">{budget.local ? 'This Mac' : hostOf(budget.server)}</span>
        {budget.state === 'ok' ? (
          <Pill variant="ok" dot>
            Signed in
          </Pill>
        ) : attention ? (
          <Pill variant="warn">Needs you</Pill>
        ) : null}
      </div>
      {message ? <p className={attention ? 'text-xs text-warn' : 'text-xs text-fg-muted'}>{message}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          What agents may do
          <NativeSelect
            className="w-auto"
            aria-label={`What agents may do with ${budgetName(budget)}`}
            value={budget.access}
            disabled={busy}
            onChange={(e) => onAccess(e.target.value as ActualAccess)}
          >
            {(['read', 'write'] as const).map((value) => (
              <option key={value} value={value}>
                {ACCESS_LABEL[value]}
              </option>
            ))}
          </NativeSelect>
        </label>
        {canSignInAgain(budget.state) ? (
          <Button type="button" size="sm" disabled={busy} onClick={onSignInAgain}>
            Sign in again
          </Button>
        ) : null}
        {budget.state !== 'server_off' ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void openActual(budget.slug).then(onMessage)}
          >
            Open Actual
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </li>
  );
};

type Dialog = { kind: 'off' } | { kind: 'remove' } | { kind: 'disconnect'; budget: ActualBudget } | null;

export const ActualDetail: React.FC<{
  id: AddonId;
  onBack(): void;
  onServices?(): void;
  onInstallStarted(): void;
}> = ({ onBack, onServices, onInstallStarted }) => {
  const listing = useAddonListing('actual');
  const install = useAddonInstall('actual');
  const overview = useActualOverview();
  const [preset, setPreset] = useState<ActualConnectPreset | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const { busy, error, note, setError, setNote, act } = useAddonActions('actual', refreshActual, () => setDialog(null));

  // Decision 22: check the stored sign-ins when the page opens, and again after a run ends.
  useRefreshOnOpen(install, refreshActual);

  if (!listing) return null;
  const { entry, fit } = listing;
  const budgets = overview?.budgets ?? [];
  const local = budgets.filter((b) => b.local);
  const remote = budgets.filter((b) => !b.local);
  const running = inProgress(install);
  const down = engineDown(listing);
  const canGet = !down && fit.verdict !== 'over';
  const serverOn = listing.installed;
  const serverSetUp = serverOn || Boolean(overview?.localSetUp);
  // Remote budgets alone still run Actual here (its MCP containers), so the page says On.
  const pill =
    !running && !serverOn && overview?.enabled && remote.length
      ? ({ tone: 'ok', label: 'On', dot: true } as const)
      : addonPill(listing, install, remote.length);
  const existing = budgets.map((b) => b.slug);

  const get = () => {
    startAddonInstall('actual', 'read');
    onInstallStarted();
  };

  const turnOff = () =>
    act(async () => {
      const result = await callIpc(() => window.electronAPI.addons.turnOff('actual'), `Couldn’t turn off ${entry.name}.`);
      return typeof result === 'string' ? result : null;
    });

  const disconnect = (budget: ActualBudget) =>
    act(async () => {
      const reply = await callIpc(
        () => window.electronAPI.addons.actual.disconnect(budget.slug),
        'Couldn’t disconnect the budget.',
      );
      if (typeof reply === 'string') return reply;
      return isActualFailure(reply.result)
        ? `Couldn’t disconnect ${budgetName(budget)} (${reply.result.error}).`
        : null;
    });

  const setAccess = (budget: ActualBudget, access: ActualAccess) =>
    act(async () => {
      const reply = await callIpc(
        () => window.electronAPI.addons.actual.setAccess(budget.slug, access),
        'Couldn’t change the access.',
      );
      if (typeof reply === 'string') return reply;
      if (isActualFailure(reply.result)) return connectErrorText(reply.result.error, budget.slug, budget.server);
      setNote(`${budgetName(budget)}: ${ACCESS_LABEL[access]}. Chats you start after this get the change.`);
      return null;
    });

  const copyPassword = async () => {
    setError(null);
    const result = await callIpc(() => window.electronAPI.addons.actual.copyPassword(), 'Couldn’t copy the password.');
    if (typeof result === 'string') setError(result);
    else setNote(PASSWORD_COPIED);
  };

  const showWays = !running && !serverSetUp && budgets.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <AddonPageTop
        entry={entry}
        pill={pill}
        running={running}
        onShowProgress={onInstallStarted}
        onBack={onBack}
        onServices={onServices}
        error={error}
        note={note}
      />
      {overview?.statusError ? (
        <Callout variant="warn">{`Couldn’t check the budgets’ sign-ins: ${overview.statusError}`}</Callout>
      ) : null}

      {showWays ? (
        <div className="grid gap-4 md:grid-cols-2">
          <SetupPath title={SETUP_WAY_TITLE.here}>
            <p className="text-xs leading-relaxed text-fg-muted">{SETUP_WAYS.actual.here}</p>
            <Facts items={hereFacts(entry)} />
            <div>
              <Button type="button" disabled={!canGet} onClick={get}>
                Get
              </Button>
            </div>
          </SetupPath>
          <SetupPath title={SETUP_WAY_TITLE.connect}>
            <p className="text-xs leading-relaxed text-fg-muted">{SETUP_WAYS.actual.connect}</p>
            <Facts items={SETUP_WAYS.actual.connectFacts} />
            <div>
              {/* Same weight as Get: neither way is the default (store decision 14). */}
              <Button type="button" onClick={() => setPreset({ server: '' })}>
                {SETUP_WAYS.actual.connectLabel}
              </Button>
            </div>
          </SetupPath>
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          {serverOn && listing.stopped && !running ? <StoppedAddonCallout listing={listing} /> : null}
          {serverOn && !running && overview && local.length === 0 ? (
            <Callout className="flex flex-col gap-2">
              <p>This Mac’s server has a budget that isn’t connected yet.</p>
              <div>
                <Button type="button" size="sm" onClick={() => setPreset({ server: 'local' })}>
                  Connect one
                </Button>
              </div>
            </Callout>
          ) : null}
          {budgets.length ? (
            <Panel
              title="Connected budgets"
              lead="Each budget is its own set of tools for agents. Unattended runs get only its read-only tools."
            >
              <ul className="flex flex-col">
                {budgets.map((budget) => (
                  <BudgetRow
                    key={budget.slug}
                    budget={budget}
                    busy={busy || running}
                    onSignInAgain={() =>
                      setPreset({
                        server: budget.server,
                        slug: budget.slug,
                        syncId: budget.syncId,
                        access: budget.access,
                        signInAgain: true,
                      })
                    }
                    onDisconnect={() => setDialog({ kind: 'disconnect', budget })}
                    onAccess={(access) => void setAccess(budget, access)}
                    onMessage={setError}
                  />
                ))}
              </ul>
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy || running}
                  onClick={() => setPreset({ server: '' })}
                >
                  Connect a budget
                </Button>
              </div>
            </Panel>
          ) : null}
          {serverSetUp ? (
            <AddonSwitchPanel
              listing={listing}
              title="This Mac’s server"
              lead={
                serverOn
                  ? 'Turning it off stops the server. Its budgets stay on this Mac and come back when you turn it on. Budgets on other servers stay connected.'
                  : 'Off. Its budgets are still on this Mac.'
              }
              locked={busy || running}
              canTurnOn={canGet}
              offOpen={dialog?.kind === 'off'}
              busy={busy}
              offTitleId="actual-off-title"
              offTitle="Turn off this Mac’s Actual server?"
              offText={`The server stops. ${
                !local.length
                  ? ''
                  : remote.length
                    ? `Agents still see ${local.map(budgetName).join(', ')}, but its tools fail until you turn the server on again. `
                    : `${local.map(budgetName).join(', ')} can’t be used until you turn it on again. `
              }${remote.length ? `${remote.map(budgetName).join(', ')} stays connected. ` : ''}Its budgets stay on this Mac.`}
              onDialog={(kind) => setDialog(kind && { kind })}
              onTurnOff={() => void turnOff()}
              onTurnOn={get}
              actions={
                serverOn ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy || running}
                      onClick={() => void openActual(null).then(setError)}
                    >
                      Open Actual
                    </Button>
                    <Button type="button" variant="secondary" disabled={busy || running} onClick={() => void copyPassword()}>
                      Copy password
                    </Button>
                  </>
                ) : null
              }
            >
              {serverOn ? (
                <p className="text-xs text-fg-faint">
                  Actual’s web app asks for the server password. Copy password puts it on the clipboard.
                </p>
              ) : null}
            </AddonSwitchPanel>
          ) : null}
          {!serverSetUp && !running ? <FitOrStackDown listing={listing} down={down} /> : null}
        </div>
        <div className="flex flex-col gap-4">
          {serverSetUp || !remote.length ? (
            <WhatItRuns listing={listing} />
          ) : (
            <Panel title="On this Mac">
              <p className="text-xs leading-relaxed text-fg-muted">
                For a budget on another server, this Mac runs only the two containers that give agents its tools.
              </p>
            </Panel>
          )}
          <ToolsAndUpdates entry={entry} />
        </div>
      </div>

      <ConfirmSheet
        open={dialog?.kind === 'disconnect'}
        busy={busy}
        titleId="actual-disconnect-title"
        title={dialog?.kind === 'disconnect' ? `Disconnect ${budgetName(dialog.budget)}?` : ''}
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.kind === 'disconnect') void disconnect(dialog.budget);
        }}
      >
        Agents lose its tools, and the stack deletes its stored sign-in. The budget stays on its server.
      </ConfirmSheet>

      {dialog?.kind === 'remove' ? (
        <RemoveDataSheet
          id="actual"
          installed={listing.installed}
          title="Remove this Mac’s Actual server and delete its budgets?"
          images={{ downloadBytes: entry.downloadBytes, again: 'Getting it again' }}
          onClose={() => setDialog(null)}
          onStarted={onInstallStarted}
        >
          {`This Mac’s budgets have no other copy. Removing deletes the server’s data folder, its password and every budget on it. It can’t be undone.${
            remote.length ? ` ${remote.map(budgetName).join(', ')} stays connected.` : ''
          }`}
        </RemoveDataSheet>
      ) : null}

      <ActualConnectSheet
        preset={preset}
        existing={existing}
        addonOn={Boolean(overview?.enabled)}
        onClose={() => setPreset(null)}
        onInstallStarted={onInstallStarted}
      />
    </div>
  );
};
