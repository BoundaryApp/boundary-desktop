import React, { useState } from 'react';
import { Callout } from '../../components/ui/alert';
import { Field } from '../../components/ui/field';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { cn } from '../../lib/utils';
import {
  BITWARDEN_COLLECTION,
  bitwardenServerUrl,
  isBitwardenFolder,
  isBitwardenSlug,
} from '../../../shared/bitwardenSlug';
import { isActualFailure, type BitwardenConnectInput, type BitwardenServer, type BitwardenUnlock } from '../../../shared/types/addons';
import { UNLOCK_LABEL, connectErrorText, hostOf } from './useBitwarden';

// Connect a Bitwarden account (spec decisions 28 and 29). The sheet asks for the server, the
// account's personal API key, a folder and how it unlocks. The key and a master password live
// only in this form's inputs; main writes them to `addon.sh`'s stdin and keeps nothing. Closing
// the sheet unmounts the form, which drops them.

/** Bitwarden's page on the personal API key: where to find it under Settings → Security → Keys. */
const API_KEY_HELP_URL = 'https://bitwarden.com/help/personal-api-key/';

const UNLOCK_HELP: Record<BitwardenUnlock, string> = {
  manual: 'The stack stores no master password. You unlock the account here after each restart of the assistant.',
  stored:
    'The stack keeps your master password, which opens your whole vault, so the account unlocks by itself after a restart. The agent still sees only the folder.',
};

type ServerKind = BitwardenServer['kind'];

const SERVER_LABEL: Record<ServerKind, string> = {
  us: 'bitwarden.com (US)',
  eu: 'bitwarden.com (EU)',
  selfhosted: 'Your own server',
};

type Failure = { body: string; replacing?: boolean };

const ConnectForm: React.FC<{
  existing: string[];
  /** A refused account's name: the sheet opens on it with replace on (Connect again). */
  reconnect?: string | null;
  /** Manual accounts unlocked now, which the broker restart locks. */
  unlocked: string[];
  onConnected(message: string): void;
  onClose(): void;
}> = ({ existing, reconnect, unlocked, onConnected, onClose }) => {
  const [kind, setKind] = useState<ServerKind>('us');
  const [url, setUrl] = useState('');
  const [slug, setSlug] = useState(reconnect ?? '');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [folder, setFolder] = useState('Agent');
  const [advanced, setAdvanced] = useState(false);
  const [collection, setCollection] = useState('');
  const [unlock, setUnlock] = useState<BitwardenUnlock>('manual');
  const [masterPassword, setMasterPassword] = useState('');
  const [replace, setReplace] = useState(Boolean(reconnect));
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const serverUrl = kind === 'selfhosted' ? bitwardenServerUrl(url) : null;
  const slugOk = isBitwardenSlug(slug);
  const exists = taken || existing.includes(slug);
  const scope = advanced && collection !== '' ? `collection:${collection}` : `folder:${folder}`;
  const scopeOk = advanced && collection !== '' ? BITWARDEN_COLLECTION.test(collection) : isBitwardenFolder(folder);
  const ready =
    !busy &&
    slugOk &&
    !(exists && !replace) &&
    (kind !== 'selfhosted' || serverUrl !== null) &&
    clientId.trim() !== '' &&
    clientSecret.trim() !== '' &&
    scopeOk &&
    (unlock === 'manual' || masterPassword !== '');

  const edited = () => setFailure(null);
  /** A new name clears what the old one learned: taken, replacing it, and the last failure. */
  const changeSlug = (value: string) => {
    setSlug(value.trim());
    setReplace(false);
    setTaken(false);
    edited();
  };
  const host = kind === 'selfhosted' ? hostOf(serverUrl ?? url) : kind === 'eu' ? 'vault.bitwarden.eu' : 'vault.bitwarden.com';
  const locks = unlocked.filter((s) => s !== slug);
  /** Still the refused account the sheet opened on, which has nothing working to keep. */
  const mending = Boolean(reconnect) && slug === reconnect;

  const connect = async () => {
    setBusy(true);
    setFailure(null);
    const server: BitwardenServer = kind === 'selfhosted' ? { kind, url: serverUrl ?? '' } : { kind };
    const input: BitwardenConnectInput = {
      slug,
      server,
      scope,
      unlock,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      ...(unlock === 'stored' ? { masterPassword } : {}),
      replace: exists && replace,
    };
    try {
      const reply = await window.electronAPI.addons.bitwarden.connect(input);
      if (!reply.success) {
        setFailure({ body: reply.error ?? 'Boundary’s add-on service didn’t answer.' });
        return;
      }
      if (isActualFailure(reply.result)) {
        const { error } = reply.result;
        if (error === 'exists') setTaken(true);
        const retryAfter = 'retryAfter' in reply.result ? reply.result.retryAfter : null;
        setFailure({ body: connectErrorText(error, slug, host, retryAfter), replacing: input.replace });
        return;
      }
      onConnected(reply.result.message);
      onClose();
    } catch (e) {
      setFailure({ body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const openHelp = (): void => {
    window.electronAPI.urls.openUrl(API_KEY_HELP_URL).catch((): void => undefined);
  };

  return (
    <Sheet
      open
      onClose={onClose}
      busy={busy}
      titleId="bitwarden-connect-title"
      title={mending ? `Connect ${slug} again` : 'Connect a Bitwarden account'}
      className="wb-sheet-wide"
      actions={
        <SheetConfirmActions
          busy={busy}
          onCancel={onClose}
          confirmLabel={busy ? 'Signing in…' : exists && replace && !mending ? 'Replace and connect' : 'Connect'}
          confirmDisabled={!ready}
          onConfirm={() => void connect()}
        />
      }
    >
      {mending ? (
        <p className="wb-sheet-lede">
          {`Enter ${slug}’s server, API key and folder again. The stack stores accounts differently since its last update, and it couldn’t carry this one over.`}
        </p>
      ) : null}
      <p className="wb-sheet-lede">
        Boundary sends the API key to the agent stack, which signs in and keeps it there. Boundary keeps none of what you type
        here.
      </p>

      <div role="radiogroup" aria-label="Server" className="mb-3.5 flex flex-col gap-2">
        <span className="text-xs font-medium text-fg">Server</span>
        {(['us', 'eu', 'selfhosted'] as const).map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="radio"
              name="bitwarden-connect-server"
              checked={kind === option}
              disabled={busy}
              onChange={() => {
                setKind(option);
                edited();
              }}
            />
            <span className="text-fg">{SERVER_LABEL[option]}</span>
          </label>
        ))}
      </div>
      {kind === 'selfhosted' ? (
        <Field
          label="Server address"
          htmlFor="bitwarden-connect-url"
          hint={
            url && !serverUrl ? (
              <span className="text-danger">Use the server’s https:// address.</span>
            ) : (
              'Your Bitwarden or Vaultwarden server, over HTTPS.'
            )
          }
        >
          <input
            id="bitwarden-connect-url"
            value={url}
            placeholder="https://vault.example.com"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setUrl(e.target.value.trim());
              edited();
            }}
          />
        </Field>
      ) : null}

      <Field
        label="Account name"
        htmlFor="bitwarden-connect-slug"
        hint={
          slug && !slugOk ? (
            <span className="text-danger">
              {slug === 'local'
                ? 'local is the stack’s own account. Choose another name.'
                : 'Start the name with a letter, and use up to 31 lowercase letters, numbers and dashes.'}
            </span>
          ) : mending ? (
            `Connecting replaces the old ${slug}, which stays as it is until the new key signs in.`
          ) : exists ? (
            <span className="text-danger">
              {`An account named ${slug} is already connected. `}
              {replace ? (
                'It stays connected until the new key signs in.'
              ) : (
                <button type="button" className="cursor-pointer text-brand hover:underline" onClick={() => setReplace(true)}>
                  Replace it
                </button>
              )}
            </span>
          ) : (
            'How this page and the agent name the account, such as personal or work.'
          )
        }
      >
        <input
          id="bitwarden-connect-slug"
          placeholder="personal"
          value={slug}
          onChange={(e) => changeSlug(e.target.value)}
          className={cn('font-mono', slug && !slugOk && 'border-danger')}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <p className="mb-2 text-xs text-fg-muted">
        {'Bitwarden shows the account’s personal API key under Settings → Security → Keys. '}
        <button type="button" className="cursor-pointer text-brand hover:underline" onClick={openHelp}>
          Where to find it
        </button>
      </p>
      <Field label="client_id" htmlFor="bitwarden-connect-client-id">
        <input
          id="bitwarden-connect-client-id"
          type="password"
          className="font-mono"
          value={clientId}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setClientId(e.target.value);
            edited();
          }}
        />
      </Field>
      <Field label="client_secret" htmlFor="bitwarden-connect-client-secret">
        <input
          id="bitwarden-connect-client-secret"
          type="password"
          className="font-mono"
          value={clientSecret}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setClientSecret(e.target.value);
            edited();
          }}
        />
      </Field>

      {advanced ? (
        <Field
          label="Organization collection ID"
          htmlFor="bitwarden-connect-collection"
          hint={
            collection && !BITWARDEN_COLLECTION.test(collection) ? (
              <span className="text-danger">Use the collection’s ID as Bitwarden shows it: letters, numbers and dashes.</span>
            ) : (
              'For an organization that gives a separate member account one collection. Leave it empty to use the folder.'
            )
          }
        >
          <input
            id="bitwarden-connect-collection"
            className="font-mono"
            value={collection}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setCollection(e.target.value.trim());
              edited();
            }}
          />
        </Field>
      ) : null}
      {advanced && collection !== '' ? null : (
        <Field
          label="Folder"
          htmlFor="bitwarden-connect-folder"
          hint={
            !isBitwardenFolder(folder) ? (
              <span className="text-danger">Name a folder, without quotes or spaces at either end.</span>
            ) : (
              `Create a folder named ${folder} in any Bitwarden app and move the logins the agent may use into it. The agent sees nothing else in the vault.`
            )
          }
        >
          <input
            id="bitwarden-connect-folder"
            value={folder}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setFolder(e.target.value);
              edited();
            }}
          />
        </Field>
      )}
      <p className="mb-3 text-xs">
        <button
          type="button"
          className="cursor-pointer text-brand hover:underline"
          aria-expanded={advanced}
          disabled={busy}
          onClick={() => {
            setAdvanced(!advanced);
            setCollection('');
            edited();
          }}
        >
          {advanced ? 'Use a folder instead' : 'Advanced: use an organization collection'}
        </button>
      </p>

      <div role="radiogroup" aria-label="How it unlocks" className="mb-3.5 flex flex-col gap-2">
        <span className="text-xs font-medium text-fg">How it unlocks</span>
        {(['manual', 'stored'] as const).map((option) => (
          <label key={option} className="flex cursor-pointer items-start gap-2 text-xs">
            <input
              type="radio"
              name="bitwarden-connect-unlock"
              className="mt-0.5"
              checked={unlock === option}
              disabled={busy}
              onChange={() => {
                setUnlock(option);
                if (option === 'manual') setMasterPassword('');
                edited();
              }}
            />
            <span className="flex flex-col gap-0.5">
              <b className="font-medium text-fg">{UNLOCK_LABEL[option]}</b>
              <span className="text-fg-muted">{UNLOCK_HELP[option]}</span>
            </span>
          </label>
        ))}
      </div>
      {unlock === 'stored' ? (
        <Field label="Master password" htmlFor="bitwarden-connect-master">
          <input
            id="bitwarden-connect-master"
            type="password"
            value={masterPassword}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => {
              setMasterPassword(e.target.value);
              edited();
            }}
          />
        </Field>
      ) : null}

      {locks.length ? (
        <p className="mb-3 text-xs text-warn">
          {`Connecting restarts Bitwarden, which locks ${locks.join(', ')}. You’ll unlock ${locks.length === 1 ? 'it' : 'them'} again afterwards.`}
        </p>
      ) : null}
      <p className="mb-3 text-xs text-fg-faint">Chats you start after this can use the account’s logins.</p>

      {failure ? (
        <Callout variant="destructive" className="flex flex-col gap-1">
          <p className="font-semibold text-danger">Couldn’t connect the account</p>
          <p>{failure.body}</p>
          <p className="text-xs text-fg-muted">
            {mending
              ? `${slug} still needs connecting again. Nothing new was saved.`
              : failure.replacing
                ? `The old ${slug} stays connected, and nothing new was saved.`
                : 'Nothing was saved.'}
          </p>
        </Callout>
      ) : null}
    </Sheet>
  );
};

/** Mounts the form only while open, so closing the sheet drops everything typed. */
export const BitwardenConnectSheet: React.FC<{
  open: boolean;
  /** Names already connected. */
  existing: string[];
  reconnect?: string | null;
  unlocked: string[];
  onConnected(message: string): void;
  onClose(): void;
}> = ({ open, ...props }) => (open ? <ConnectForm {...props} /> : null);
