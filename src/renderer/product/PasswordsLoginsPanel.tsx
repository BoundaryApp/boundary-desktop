import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Globe,
  KeyRound,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { BUILTIN_ASSISTANT_SLUG } from '../../shared/types/hermesChat';
import { builtinAgent, builtinAgentName } from '../../shared/hermesAgentIdentity';
import { useStoredAgents, useToast } from './settingsPanelHooks';
import type {
  VaultIdentifierType,
  VaultListResult,
  VaultLogin,
  VaultSourcesResult,
  VaultSourceStatus,
} from '../../shared/types/hermesVault';
import {
  knownSiteForOrigin,
  labelForOrigin,
  originFromInput,
  signInOriginMismatch,
  suggestSignInSites,
} from '../../shared/vaultSites';
import { InfoTip } from '../components/ui/info-tip';
import { Segmented } from '../components/ui/segmented';
import { Sheet } from '../components/ui/sheet';
import { useSheetAction } from '../components/ui/use-sheet-action';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/menu';
import { APP_NAME } from '../../shared/buildIdentity';
import { RetryCallout } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Field } from '../components/ui/field';
import { InlineConfirm } from '../components/ui/inline-confirm';
import { PasswordField } from '../components/ui/password-field';
import { NativeSelect } from '../components/ui/native-select';
import { Input } from '../components/ui/input';
import { Listbox, ListboxOption } from '../components/ui/listbox';
import { useListNavigation } from '../components/ui/use-list-navigation';

/** Passwords & Logins (docs/passwords-logins-study). */

const ID_TYPES: Array<{
  value: VaultIdentifierType;
  label: string;
  placeholder: string;
}> = [
  { value: 'email', label: 'Email', placeholder: 'you@example.com' },
  { value: 'username', label: 'Username', placeholder: 'username' },
  { value: 'phone', label: 'Phone', placeholder: '+1 555 0100' },
];

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function addedOn(createdAt: string | null): string {
  if (!createdAt) return '';
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return `Added ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function siteLetter(login: VaultLogin): string {
  const name = knownSiteForOrigin(login.origin)?.name ?? login.label;
  return (name.trim()[0] ?? '?').toUpperCase();
}

type SheetState = { mode: 'add' } | { mode: 'replace'; login: VaultLogin };

export const PasswordsLoginsPanel: React.FC<{ initialAgentSlug?: string }> = ({
  initialAgentSlug,
}) => {
  const agents = useStoredAgents();
  const [agentSlug, setAgentSlug] = useState(initialAgentSlug || BUILTIN_ASSISTANT_SLUG);
  const [logins, setLogins] = useState<VaultLogin[]>([]);
  const [sources, setSources] = useState<VaultSourceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const agentName =
    agents.find((a) => a.slug === agentSlug)?.displayName ??
    (agentSlug === BUILTIN_ASSISTANT_SLUG ? builtinAgentName(agents) : agentSlug);

  const refresh = useCallback(async (slug: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const [list, srcs] = await Promise.all([
      window.electronAPI.hermesVault.listLogins({ agentSlug: slug }).catch(
        (): VaultListResult => ({ success: false, logins: [], error: 'Couldn’t load logins.' })
      ),
      window.electronAPI.hermesVault
        .listSources({ agentSlug: slug })
        .catch((): VaultSourcesResult => ({ success: false, sources: [] })),
    ]);
    if (seq !== loadSeq.current) return;
    setLogins(list.logins);
    setLoadError(list.success ? null : (list.error ?? 'Couldn’t load logins.'));
    setSources(srcs.success ? srcs.sources.filter((s) => s.name !== 'local') : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    setMenuId(null);
    setConfirmId(null);
    setRowError(null);
    void refresh(agentSlug);
  }, [agentSlug, refresh]);

  const remove = async (login: VaultLogin) => {
    setBusyId(login.id);
    setRowError(null);
    const result = await window.electronAPI.hermesVault.removeLogin({
      agentSlug,
      id: login.id,
    });
    setBusyId(null);
    if (!result.success) {
      setRowError(result.error ?? 'Couldn’t remove that login.');
      return;
    }
    setConfirmId(null);
    setToast(`Removed the ${login.label} login`);
    void refresh(agentSlug);
  };

  const onSaved = (message: string) => {
    setSheet(null);
    setToast(message);
    void refresh(agentSlug);
  };

  return (
    <div className="wb-vault">
      <p className="wb-inference-lead">
        Logins your agents use to sign in. <strong>The model never sees the password.</strong>
        <InfoTip label="saved logins">
          The agent types the username. The password is filled straight into the page from the
          agent’s encrypted vault.
        </InfoTip>
      </p>

      <div className="wb-vault-toolbar">
        <label className="wb-vault-agent">
          Logins for
          <NativeSelect size="sm" value={agentSlug} onChange={(e) => setAgentSlug(e.target.value)}>
            {(agents.length
              ? agents
              : [builtinAgent(agents)]
            ).map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.displayName}
              </option>
            ))}
          </NativeSelect>
        </label>
        <span className="wb-vault-grow" />
        <Button
          type="button"
          className="gap-1.5"
          disabled={Boolean(loadError)}
          onClick={() => setSheet({ mode: 'add' })}
        >
          <Plus size={14} aria-hidden="true" />
          Add login
        </Button>
      </div>

      {loadError ? (
        <RetryCallout message={loadError} onRetry={() => void refresh(agentSlug)} />
      ) : loading && logins.length === 0 ? (
        <p className="wb-settings-hint">Loading logins…</p>
      ) : logins.length === 0 ? (
        <div className="wb-vault-list wb-vault-empty">
          <h3>{agentName} has no saved logins</h3>
          <p>Ask {agentName} to sign in somewhere and it saves the login here, or add one now.</p>
          <Button
            type="button"
            variant="secondary"
            className="gap-1.5"
            onClick={() => setSheet({ mode: 'add' })}
          >
            <Plus size={14} aria-hidden="true" />
            Add login
          </Button>
        </div>
      ) : (
        <ul className="wb-vault-list" aria-label={`Logins for ${agentName}`}>
          {logins.map((login) => {
            const local = login.backend === 'local';
            const source = sources.find((s) => s.name === login.backend);
            return (
              <li key={`${login.backend}:${login.id}`}>
                <div className="wb-vault-row">
                  <span className="wb-vault-glyph" aria-hidden="true">
                    {siteLetter(login)}
                  </span>
                  <div className="wb-vault-meta">
                    <span className="wb-vault-name">
                      <span className="wb-vault-label" title={login.label}>
                        {login.label}
                      </span>
                      {!local ? (
                        <span className="wb-vault-pill is-brand">
                          {source?.displayName ?? login.backend}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="wb-vault-sub"
                      title={login.identifier ? `${login.origin} · ${login.identifier}` : login.origin}
                    >
                      <span className="mono">{login.origin}</span>
                      {login.identifier ? ` · ${login.identifier}` : ''}
                    </span>
                  </div>
                  <span className="wb-vault-date">{local ? addedOn(login.createdAt) : ''}</span>
                  {local ? (
                    <div className="wb-vault-menu-wrap">
                      <Menu
                        open={menuId === login.id}
                        onOpenChange={(open) => {
                          if (open) setConfirmId(null);
                          setMenuId(open ? login.id : null);
                        }}
                      >
                        <MenuTrigger>
                          <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            className="wb-vault-more"
                            aria-label={`More for ${login.label}`}
                          >
                            <MoreHorizontal size={16} aria-hidden="true" />
                          </Button>
                        </MenuTrigger>
                        <MenuContent side="bottom" align="end">
                          <MenuItem
                            icon={<RefreshCw size={14} />}
                            onSelect={() => setSheet({ mode: 'replace', login })}
                          >
                            Replace password
                          </MenuItem>
                          <MenuItem
                            variant="danger"
                            icon={<Trash2 size={14} />}
                            onSelect={() => {
                              setRowError(null);
                              setConfirmId(login.id);
                            }}
                          >
                            Remove
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </div>
                  ) : (
                    <span
                      className="wb-vault-date"
                      title={`Change it in ${source?.displayName ?? login.backend}`}
                    >
                      <Lock
                        size={14}
                        aria-label={`Managed in ${source?.displayName ?? login.backend}`}
                      />
                    </span>
                  )}
                </div>
                {confirmId === login.id ? (
                  <InlineConfirm
                    label={`Remove the ${login.label} login`}
                    confirmLabel={busyId === login.id ? 'Removing…' : 'Remove login'}
                    busy={busyId === login.id}
                    error={rowError}
                    escapeDisabled={Boolean(sheet)}
                    onCancel={() => setConfirmId(null)}
                    onConfirm={() => void remove(login)}
                  >
                    Remove the {login.label} login? {agentName} will ask you for it again the next
                    time it signs in to <span className="mono">{hostOf(login.origin)}</span>.
                  </InlineConfirm>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {sources.length > 0 ? (
        <>
          <h3 className="wb-vault-label">Password managers</h3>
          <ul className="wb-vault-list" aria-label="Password managers">
            {sources.map((source) => (
              <SourceRow
                key={source.name}
                source={source}
                agentSlug={agentSlug}
                agentName={agentName}
                loginCount={logins.filter((l) => l.backend === source.name).length}
                onChanged={(message) => {
                  setToast(message);
                  void refresh(agentSlug);
                }}
              />
            ))}
          </ul>
        </>
      ) : null}

      {sheet ? (
        <LoginSheet
          state={sheet}
          agentSlug={agentSlug}
          agentName={agentName}
          onCancel={() => setSheet(null)}
          onSaved={onSaved}
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

function SourceRow({
  source,
  agentSlug,
  agentName,
  loginCount,
  onChanged,
}: {
  source: VaultSourceStatus;
  agentSlug: string;
  agentName: string;
  loginCount: number;
  onChanged: (message: string) => void;
}) {
  const [unlocking, setUnlocking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  const cancel = () => {
    setUnlocking(false);
    setPassword('');
    setError(null);
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    const result = await window.electronAPI.hermesVault.unlockSource({
      agentSlug,
      name: source.name,
      password,
    });
    setBusy(false);
    setPassword('');
    if (!result.success) {
      setError(result.error ?? `Couldn’t unlock ${source.displayName}.`);
      return;
    }
    setUnlocking(false);
    onChanged(`Unlocked ${source.displayName} until the agent stack restarts`);
  };

  const lock = async () => {
    setBusy(true);
    const result = await window.electronAPI.hermesVault.lockSource({
      agentSlug,
      name: source.name,
    });
    setBusy(false);
    if (result.success) onChanged(`Locked ${source.displayName}`);
    else setError(result.error ?? `Couldn’t lock ${source.displayName}.`);
  };

  let pill: React.ReactNode;
  let sub: string;
  let action: React.ReactNode = null;
  if (!source.installed) {
    pill = <span className="wb-vault-pill">Not installed</span>;
    sub = `The ${source.displayName} CLI isn’t in the agent stack, so its logins can’t be used.`;
  } else if (!source.enabled) {
    pill = <span className="wb-vault-pill">Off</span>;
    sub = `Turned off in Hermes. Agents don’t use its logins.`;
  } else if (source.needsUnlock && !source.unlocked) {
    pill = <span className="wb-vault-pill is-warn">Locked</span>;
    sub = 'Found in the agent stack. Unlock to let agents use its logins.';
    if (!unlocking) {
      action = (
        <Button
          type="button"
          variant="secondary"
          className="gap-1.5"
          onClick={() => setUnlocking(true)}
        >
          <KeyRound size={14} aria-hidden="true" />
          Unlock
        </Button>
      );
    }
  } else {
    pill = <span className="wb-vault-pill is-ok">Unlocked</span>;
    sub = `${loginCount} ${loginCount === 1 ? 'login' : 'logins'} available to ${agentName} until the agent stack restarts.`;
    action = (
      <Button
        type="button"
        variant="secondary"
        className="gap-1.5"
        disabled={busy}
        onClick={() => void lock()}
      >
        <Lock size={14} aria-hidden="true" />
        Lock
      </Button>
    );
  }

  return (
    <li>
      <div className="wb-vault-row">
        <span className="wb-vault-glyph" aria-hidden="true">
          <KeyRound size={14} />
        </span>
        <div className="wb-vault-meta">
          <span className="wb-vault-name">
            <span className="wb-vault-label" title={source.displayName}>
              {source.displayName}
            </span>
            {pill}
          </span>
          <span className="wb-vault-sub" title={sub}>
            {sub}
          </span>
        </div>
        {action}
      </div>
      {unlocking ? (
        <form className="wb-vault-unlock" onSubmit={(e) => void unlock(e)}>
          <label htmlFor={inputId} className="sr-only">
            {source.displayName} master password
          </label>
          <Input
            id={inputId}
            className="min-w-[160px] flex-1"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder={`${source.displayName} master password`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="button" variant="secondary" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !password}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
          <p className="wb-vault-note">
            Sent to {source.displayName} to unlock it. {APP_NAME} and Hermes don’t store it.
          </p>
        </form>
      ) : null}
      {error ? <p className="wb-sheet-error wb-vault-row-error">{error}</p> : null}
    </li>
  );
}

function LoginSheet({
  state,
  agentSlug,
  agentName,
  onCancel,
  onSaved,
}: {
  state: SheetState;
  agentSlug: string;
  agentName: string;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const replacing = state.mode === 'replace' ? state.login : null;
  const [site, setSite] = useState(replacing ? replacing.label : '');
  const [pickedOrigin, setPickedOrigin] = useState<string | null>(
    replacing ? replacing.origin : null
  );
  const [keepTyped, setKeepTyped] = useState(false);
  const [idType, setIdType] = useState<VaultIdentifierType>(replacing?.identifierType ?? 'email');
  const [identifier, setIdentifier] = useState(replacing?.identifier ?? '');
  const [password, setPassword] = useState('');
  const save = useSheetAction();
  const { busy, error, setError } = save;
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const origin = pickedOrigin ?? originFromInput(site);
  const suggestions = pickedOrigin ? [] : suggestSignInSites(site);
  const mismatch = origin && !keepTyped && !replacing ? signInOriginMismatch(origin) : null;
  const idMeta = ID_TYPES.find((t) => t.value === idType) ?? ID_TYPES[0];
  const ready = Boolean(origin && identifier.trim() && password && !mismatch);

  const pick = (nextOrigin: string) => {
    setPickedOrigin(nextOrigin);
    setSite(knownSiteForOrigin(nextOrigin)?.name ?? site);
    setKeepTyped(false);
    window.setTimeout(() => (identifier.trim() ? passwordRef : identifierRef).current?.focus(), 0);
  };

  // Known sites under the Site field: arrows move the active row from the field, Enter picks
  // it. No row is active until an arrow is pressed, so Enter still submits the form.
  const sitesId = useId();
  const [activeSite, setActiveSite] = useState(-1);
  const sitesNav = useListNavigation({
    id: sitesId,
    open: suggestions.length > 0,
    count: suggestions.length,
    active: activeSite,
    onActiveChange: setActiveSite,
    onPick: (index) => {
      const chosen = suggestions[index];
      if (chosen) pick(chosen.origin);
    },
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || !origin) return;
    await save.run(async () => {
      const result = replacing
        ? await window.electronAPI.hermesVault.replacePassword({
            agentSlug,
            id: replacing.id,
            password,
          })
        : await window.electronAPI.hermesVault.addLogin({
            agentSlug,
            label: labelForOrigin(origin),
            origin,
            identifierType: idType,
            identifier: identifier.trim(),
            password,
          });
      if (!result.success) {
        setError(result.error ?? 'Couldn’t save that login.');
        return;
      }
      setPassword('');
      const label = replacing ? replacing.label : labelForOrigin(origin);
      onSaved(
        result.error ??
          (replacing ? `Replaced the ${label} password` : `Saved the ${label} login for ${agentName}`)
      );
    });
  };

  return (
    <Sheet
      as="form"
      onSubmit={(e) => void submit(e)}
      open
      onClose={onCancel}
      busy={busy}
      titleId="wb-vault-sheet-title"
      className="wb-vault-sheet"
      backdropClassName="wb-vault-backdrop"
      title={replacing ? `Replace ${replacing.label} password` : `Add a login for ${agentName}`}
      error={error}
      actionsClassName="wb-vault-sheet-actions"
      actions={
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !ready}>
            {busy ? 'Saving…' : replacing ? 'Replace password' : 'Save login'}
          </Button>
        </>
      }
    >
      <Field
        label="Site"
        htmlFor="wb-vault-site"
        hint={
          !origin && suggestions.length === 0
            ? 'Use the page where the sign-in form is, not a profile or home page.'
            : undefined
        }
      >
        <Input
          id="wb-vault-site"
          value={site}
          disabled={Boolean(replacing) || busy}
          autoFocus={!replacing}
          autoComplete="off"
          placeholder="LinkedIn, or paste the sign-in page URL"
          {...sitesNav.fieldProps}
          onChange={(e) => {
            setSite(e.target.value);
            setPickedOrigin(null);
            setKeepTyped(false);
            setActiveSite(-1);
          }}
        />
        {suggestions.length > 0 ? (
          <Listbox id={sitesId} className="wb-vault-suggest" aria-label="Known sites">
            {suggestions.map((s, i) => (
              <ListboxOption
                key={s.origin}
                id={sitesNav.optionId(i)}
                active={i === activeSite}
                selected={i === activeSite}
                onPick={() => pick(s.origin)}
                hint={<span className="mono">{s.origin}</span>}
              >
                {s.name}
              </ListboxOption>
            ))}
          </Listbox>
        ) : null}
        {origin && !mismatch ? (
          <p className="wb-vault-origin">
            <Globe size={13} aria-hidden="true" />
            Fills only on <span className="mono">{origin}</span>
          </p>
        ) : null}
        {mismatch && origin ? (
          <div className="wb-vault-warn" role="alert">
            <p>
              {mismatch.name}’s sign-in form is on <span className="mono">{mismatch.origin}</span>
              . A login saved for <span className="mono">{origin}</span> won’t be filled there.
            </p>
            <div className="wb-vault-warn-actions">
              <Button type="button" onClick={() => pick(mismatch.origin)}>
                Use {hostOf(mismatch.origin)}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setPickedOrigin(origin);
                  setKeepTyped(true);
                }}
              >
                Keep {hostOf(origin)}
              </Button>
            </div>
          </div>
        ) : null}
      </Field>

      {/* A caption for a button group, which a <label> can't name, so not a Field. */}
      <div className="wb-field">
        <span className="wb-field-label" id="wb-vault-idtype">
          Signs in with
        </span>
        <Segmented<VaultIdentifierType>
          aria-labelledby="wb-vault-idtype"
          options={ID_TYPES.map((t) => ({ value: t.value, label: t.label }))}
          value={idType}
          disabled={Boolean(replacing) || busy}
          onChange={setIdType}
        />
      </div>

      <Field label={idMeta.label} htmlFor="wb-vault-identifier">
        <Input
          id="wb-vault-identifier"
          ref={identifierRef}
          value={identifier}
          disabled={Boolean(replacing) || busy}
          autoComplete="off"
          placeholder={idMeta.placeholder}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </Field>

      <Field label={replacing ? 'New password' : 'Password'} htmlFor="wb-vault-password">
        <PasswordField
          id="wb-vault-password"
          ref={passwordRef}
          value={password}
          disabled={busy}
          autoFocus={Boolean(replacing)}
          autoComplete="new-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      <p className="wb-vault-lockline">
        <Lock size={13} aria-hidden="true" />
        Saved encrypted in {agentName}’s vault. {APP_NAME} can’t show it again, and the model never
        sees it.
      </p>
    </Sheet>
  );
}
