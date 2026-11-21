import React, { useState } from 'react';
import { Callout } from '../../components/ui/alert';
import { Input } from '../../components/ui/input';
import { Field } from '../../components/ui/field';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { useSheetAction } from '../../components/ui/use-sheet-action';
import { slugFromName } from '../../../shared/actualSlug';
import { ADDON_SLUG } from '../../../shared/utils/slug';
import {
  isActualFailure,
  type ActualAccess,
  type ActualConnectInput,
  type ActualServerBudget,
} from '../../../shared/types/addons';
import { AccessRadios, ChangeWayLink, STILL_SHEET } from './addonFormParts';
import { connectErrorText, refreshActual } from './useActual';
import { startActualRemoteInstall } from './useAddons';
import { ChoiceGroup } from '../../components/ui/choice-group';
import { ChoiceRow } from '../../components/ui/choice-row';
import { Radio } from '../../components/ui/radio';
import { ADDON_SLUG_RULE } from './addonCopy';

// Connect a budget (spec decision 20). The sheet asks for a server address and its password,
// lists the budgets that password opens, and connects the one picked with the name agents use.
// The password, a session token and an encryption password live only in this form's inputs;
// main passes them to the stack script's stdin and keeps nothing. Closing the sheet unmounts
// the form, which drops them.

const URL_START = /^https?:\/\/\S+$/;

export const ACTUAL_ACCESS_HELP: Record<ActualAccess, string> = {
  read: 'Chats get only the read-only tools for this budget.',
  write: 'Chats also get the tools that add, change and delete transactions, categories and rules.',
};

/** What the sheet starts with. Sign in again fills in the row's name, server and access. */
export interface ActualConnectPreset {
  server: string;
  slug?: string;
  syncId?: string;
  access?: ActualAccess;
  /** Sign in again: the name is fixed and the old connection is replaced. */
  signInAgain?: boolean;
}

type Failure = { title: string; body: string; removed?: boolean };

interface FormProps {
  preset: ActualConnectPreset;
  existing: string[];
  /** Actual is on (`ACTUAL_MCP_ENABLED`). While it's off, Connect runs as an install. */
  addonOn: boolean;
  onClose(): void;
  /** Called when Connect hands off to the install, so the page can show its steps. */
  onInstallStarted(): void;
  /** Set when the store's Get opened this as its second step: back to the choice of ways. */
  onChangeWay?(): void;
}

const ConnectForm: React.FC<FormProps> = ({ preset, existing, addonOn, onClose, onInstallStarted, onChangeWay }) => {
  const local = preset.server === 'local';
  const [server, setServer] = useState(local ? '' : preset.server);
  const [password, setPassword] = useState('');
  const [useToken, setUseToken] = useState(false);
  const [token, setToken] = useState('');
  const [budgets, setBudgets] = useState<ActualServerBudget[] | null>(null);
  const [syncId, setSyncId] = useState(preset.syncId ?? '');
  const [slug, setSlug] = useState(preset.slug ?? '');
  const [access, setAccess] = useState<ActualAccess>(preset.access ?? 'read');
  const [encryption, setEncryption] = useState('');
  const [askEncryption, setAskEncryption] = useState(false);
  const [replace, setReplace] = useState(Boolean(preset.signInAgain));
  const [taken, setTaken] = useState(false);
  const sheet = useSheetAction();
  const [phase, setPhase] = useState<'listing' | 'connecting'>('listing');
  const busy = sheet.busy ? phase : null;
  const [returned, setFailure] = useState<Failure | null>(null);
  const failure: Failure | null =
    returned ??
    (sheet.error
      ? { title: phase === 'listing' ? 'Couldn’t list the budgets' : 'The connection didn’t finish', body: sheet.error }
      : null);

  const serverValue = local ? 'local' : server;
  const credential = useToken ? { sessionToken: token } : { password };
  const credentialOk = local || (useToken ? token !== '' : password !== '');
  const serverOk = local || URL_START.test(server);
  const picked = budgets?.find((b) => b.syncId === syncId) ?? null;
  const slugOk = ADDON_SLUG.test(slug);
  const exists = !preset.signInAgain && (taken || existing.includes(slug));
  const needsEncryption = askEncryption || Boolean(picked?.encrypted);
  const ready =
    !busy &&
    serverOk &&
    credentialOk &&
    picked !== null &&
    slugOk &&
    !(exists && !replace) &&
    !(needsEncryption && encryption === '');

  const edited = () => {
    setFailure(null);
    sheet.setError(null);
  };
  const credentialsChanged = () => {
    setBudgets(null);
    edited();
  };

  const listBudgets = async () => {
    setPhase('listing');
    setFailure(null);
    await sheet.run(async () => {
      const reply = await window.electronAPI.addons.actual.serverBudgets({ server: serverValue, ...credential });
      if (!reply.success) {
        setFailure({ title: 'Couldn’t list the budgets', body: reply.error ?? 'Boundary’s add-on service didn’t answer.' });
        return;
      }
      if (isActualFailure(reply.result)) {
        setFailure({ title: 'Couldn’t list the budgets', body: connectErrorText(reply.result.error, slug, serverValue) });
        return;
      }
      const list = reply.result.budgets;
      setBudgets(list);
      const keep = list.find((b) => b.syncId === syncId) ?? (list.length === 1 ? list[0] : undefined);
      if (keep) choose(keep);
      else if (!list.length) setFailure({ title: 'No budgets', body: 'This account can’t open any budget on that server.' });
    });
  };

  const choose = (b: ActualServerBudget) => {
    setSyncId(b.syncId);
    if (!preset.signInAgain) {
      setSlug(slugFromName(b.name));
      setReplace(false);
      setTaken(false);
    }
    edited();
  };

  const connect = async () => {
    if (!picked) return;
    setPhase('connecting');
    setFailure(null);
    const input: ActualConnectInput = {
      server: serverValue,
      ...credential,
      slug,
      syncId: picked.syncId,
      access,
      replace,
      ...(needsEncryption && encryption ? { encryptionPassword: encryption } : {}),
    };
    if (!addonOn) {
      // Turning Actual on the first time takes minutes, so the install view shows the steps.
      startActualRemoteInstall(input);
      onInstallStarted();
      onClose();
      return;
    }
    await sheet.run(async () => {
      const reply = await window.electronAPI.addons.actual.connect(input);
      if (!reply.success) {
        setFailure({ title: 'The connection didn’t finish', body: reply.error ?? 'Boundary’s add-on service didn’t answer.' });
        return;
      }
      if (isActualFailure(reply.result)) {
        const { error } = reply.result;
        if (error === 'exists') setTaken(true);
        if (error === 'encryption_password') setAskEncryption(true);
        // Replacing disconnects first (the stack's connect has no --force), so the old one is gone.
        setFailure({ title: 'Couldn’t connect the budget', body: connectErrorText(error, slug, serverValue), removed: replace });
        return;
      }
      void refreshActual();
      onClose();
    });
  };

  const listed = budgets !== null;
  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy !== null}
      titleId="actual-connect-title"
      title={preset.signInAgain ? `Sign in again to budget-${preset.slug}` : local ? 'Connect a budget on this Mac' : 'Connect a budget'}
      {...(onChangeWay
        ? { ...STILL_SHEET, kicker: <ChangeWayLink disabled={busy !== null} onClick={onChangeWay} /> }
        : { className: 'wb-sheet-wide' })}
      actions={
        listed ? (
          <SheetConfirmActions
            busy={busy !== null}
            onCancel={onClose}
            confirmLabel={busy === 'connecting' ? 'Connecting…' : replace ? 'Replace and connect' : 'Connect'}
            confirmDisabled={!ready}
            onConfirm={() => void connect()}
          />
        ) : (
          <SheetConfirmActions
            busy={busy !== null}
            onCancel={onClose}
            confirmLabel={busy === 'listing' ? 'Signing in…' : 'Show budgets'}
            confirmDisabled={!serverOk || !credentialOk || busy !== null}
            onConfirm={() => void listBudgets()}
          />
        )
      }
    >
      <p className="wb-sheet-lede">
        {local
          ? 'The stack signs in to this Mac’s server with the password it generated.'
          : 'Boundary sends the password to the agent stack, which signs in once and keeps only the session it gets back. Boundary keeps neither.'}
      </p>
      {local ? null : (
        <>
          <Field label="Server address" htmlFor="actual-connect-server" hint="The address you open Actual at.">
            <Input
              id="actual-connect-server"
              value={server}
              placeholder="https://budget.example.com"
              disabled={busy !== null || Boolean(preset.signInAgain)}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setServer(e.target.value.trim());
                credentialsChanged();
              }}
            />
          </Field>
          {useToken ? (
            <Field
              label="Session token"
              htmlFor="actual-connect-token"
              hint="For a server that signs in through OpenID. Sign in to Actual in your browser, open the developer tools, and under Application → IndexedDB → actual → asyncStorage copy the value of user-token. It isn’t a cookie."
            >
              <Input
                id="actual-connect-token"
                type="password"
                className="font-mono"
                value={token}
                disabled={busy !== null}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setToken(e.target.value.trim());
                  credentialsChanged();
                }}
              />
            </Field>
          ) : (
            <Field label="Server password" htmlFor="actual-connect-password">
              <Input
                id="actual-connect-password"
                type="password"
                value={password}
                disabled={busy !== null}
                autoComplete="off"
                onChange={(e) => {
                  setPassword(e.target.value);
                  credentialsChanged();
                }}
              />
            </Field>
          )}
          <p className="mb-3 text-xs">
            <button
              type="button"
              className="cursor-pointer text-brand hover:underline"
              disabled={busy !== null}
              onClick={() => {
                setUseToken(!useToken);
                credentialsChanged();
              }}
            >
              {useToken ? 'Use the server password instead' : 'Use a session token instead'}
            </button>
          </p>
        </>
      )}

      {listed && budgets.length ? (
        <ChoiceGroup label="Budget" kind="radio">
          {budgets.map((b) => (
            <ChoiceRow
              key={b.syncId}
              control={
                <Radio
                  name="actual-connect-budget"
                  checked={syncId === b.syncId}
                  disabled={busy !== null}
                  onChange={() => choose(b)}
                />
              }
              title={
                <>
                  {b.name}
                  {b.encrypted ? <span className="ms-2 font-normal text-fg-faint">Encrypted</span> : null}
                </>
              }
            />
          ))}
        </ChoiceGroup>
      ) : null}

      {listed && picked ? (
        <>
          <Field
            label="Name agents use"
            htmlFor="actual-connect-slug"
            hint={
              slug && !slugOk ? (
                <span className="text-danger">{ADDON_SLUG_RULE}</span>
              ) : exists ? (
                <span className="text-danger">
                  {`budget-${slug} is already connected. `}
                  {replace ? (
                    'Connecting removes the old connection first.'
                  ) : (
                    <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => setReplace(true)}>
                      Replace it
                    </button>
                  )}
                </span>
              ) : (
                `Agents see this budget as budget-${slug || '…'}.`
              )
            }
          >
            <Input
              id="actual-connect-slug"
              className="font-mono" aria-invalid={Boolean(slug && !slugOk)}
              value={slug}
              disabled={busy !== null || Boolean(preset.signInAgain)}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setSlug(e.target.value.trim());
                setReplace(false);
                setTaken(false);
                edited();
              }}
            />
          </Field>
          {needsEncryption ? (
            <Field label="Encryption password" htmlFor="actual-connect-encryption" hint="The password this budget’s end-to-end encryption uses.">
              <Input
                id="actual-connect-encryption"
                type="password"
                value={encryption}
                disabled={busy !== null}
                autoComplete="off"
                onChange={(e) => {
                  setEncryption(e.target.value);
                  edited();
                }}
              />
            </Field>
          ) : null}
          <AccessRadios
            name="actual-connect-access"
            className="mb-3.5"
            value={access}
            help={ACTUAL_ACCESS_HELP}
            disabled={busy !== null}
            onChange={(value) => {
              setAccess(value);
              edited();
            }}
          />
          <p className="mb-3 text-xs text-fg-faint">
            {preset.signInAgain || replace
              ? 'The old connection is removed first. Chats you start after this can use the budget.'
              : 'Chats you start after this can use the budget. Chats already open keep the tools they started with.'}
          </p>
        </>
      ) : null}

      {failure ? (
        <Callout variant="destructive" className="flex flex-col gap-1">
          <p className="font-semibold text-danger">{failure.title}</p>
          <p>{failure.body}</p>
          <p className="text-xs text-fg-muted">
            {failure.removed ? 'The old connection was removed, and nothing new was saved.' : 'Nothing was saved.'}
          </p>
        </Callout>
      ) : null}
    </Sheet>
  );
};

/** Mounts the form only while open, so closing the sheet drops everything typed. */
export const ActualConnectSheet: React.FC<{
  preset: ActualConnectPreset | null;
  /** Names already connected, without `budget-`. */
  existing: string[];
  addonOn: boolean;
  onClose(): void;
  onInstallStarted(): void;
  onChangeWay?(): void;
}> = ({ preset, ...rest }) => (preset ? <ConnectForm key={`${preset.server}:${preset.slug ?? ''}`} preset={preset} {...rest} /> : null);
