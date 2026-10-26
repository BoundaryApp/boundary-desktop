import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { AgentProfile } from '../../shared/types/hermesChat';
import { BUILTIN_ASSISTANT_SLUG } from '../../shared/types/hermesChat';
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
import { hermesChatIPC } from '../services/hermesChatIPCService';
import { hermesVaultIPC } from '../services/hermesVaultIPCService';
import { useEscapeToClose } from './useAppShortcuts';
import { InfoTip } from '../components/ui/info-tip';

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
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [agentSlug, setAgentSlug] = useState(initialAgentSlug || BUILTIN_ASSISTANT_SLUG);
  const [logins, setLogins] = useState<VaultLogin[]>([]);
  const [sources, setSources] = useState<VaultSourceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const agentName =
    agents.find((a) => a.slug === agentSlug)?.displayName ??
    (agentSlug === BUILTIN_ASSISTANT_SLUG ? 'Hermes' : agentSlug);

  useEffect(() => {
    let alive = true;
    void hermesChatIPC
      .listAgents()
      .then((result) => {
        if (alive && result.success) setAgents(result.agents);
      })
      .catch((): void => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(async (slug: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const [list, srcs] = await Promise.all([
      hermesVaultIPC.listLogins(slug).catch(
        (): VaultListResult => ({ success: false, logins: [], error: 'Couldn’t load logins.' })
      ),
      hermesVaultIPC
        .listSources(slug)
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

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!menuId) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.('.wb-vault-menu-wrap')) setMenuId(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuId]);

  useEscapeToClose(
    () => {
      setMenuId(null);
      setConfirmId(null);
    },
    Boolean(sheet) || (!menuId && !confirmId)
  );

  const remove = async (login: VaultLogin) => {
    setBusyId(login.id);
    setRowError(null);
    const result = await hermesVaultIPC.removeLogin({
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
          <select value={agentSlug} onChange={(e) => setAgentSlug(e.target.value)}>
            {(agents.length
              ? agents
              : [{ slug: BUILTIN_ASSISTANT_SLUG, displayName: 'Hermes' }]
            ).map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.displayName}
              </option>
            ))}
          </select>
        </label>
        <span className="wb-vault-grow" />
        <button
          type="button"
          className="wb-btn-solid wb-vault-icon-btn"
          disabled={Boolean(loadError)}
          onClick={() => setSheet({ mode: 'add' })}
        >
          <Plus size={14} aria-hidden="true" />
          Add login
        </button>
      </div>

      {loadError ? (
        <div className="wb-vault-banner" role="alert">
          <span>{loadError}</span>
          <button type="button" className="wb-btn-ghost" onClick={() => void refresh(agentSlug)}>
            Try again
          </button>
        </div>
      ) : loading && logins.length === 0 ? (
        <p className="wb-settings-hint">Loading logins…</p>
      ) : logins.length === 0 ? (
        <div className="wb-vault-list wb-vault-empty">
          <h3>{agentName} has no saved logins</h3>
          <p>Ask {agentName} to sign in somewhere and it saves the login here, or add one now.</p>
          <button
            type="button"
            className="wb-btn-ghost wb-vault-icon-btn"
            onClick={() => setSheet({ mode: 'add' })}
          >
            <Plus size={14} aria-hidden="true" />
            Add login
          </button>
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
                      <button
                        type="button"
                        className="wb-btn-ghost wb-vault-more"
                        aria-label={`More for ${login.label}`}
                        aria-expanded={menuId === login.id}
                        aria-haspopup="menu"
                        onClick={() => {
                          setConfirmId(null);
                          setMenuId(menuId === login.id ? null : login.id);
                        }}
                      >
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </button>
                      {menuId === login.id ? (
                        <div className="wb-vault-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuId(null);
                              setSheet({ mode: 'replace', login });
                            }}
                          >
                            <RefreshCw size={14} aria-hidden="true" />
                            Replace password
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="is-danger"
                            onClick={() => {
                              setMenuId(null);
                              setRowError(null);
                              setConfirmId(login.id);
                            }}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            Remove
                          </button>
                        </div>
                      ) : null}
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
                  <div
                    className="wb-vault-confirm"
                    role="alertdialog"
                    aria-label={`Remove the ${login.label} login`}
                  >
                    <p>
                      Remove the {login.label} login? {agentName} will ask you for it again the next
                      time it signs in to <span className="mono">{hostOf(login.origin)}</span>.
                    </p>
                    {rowError ? <p className="wb-sheet-error">{rowError}</p> : null}
                    <div className="wb-vault-confirm-actions">
                      <button
                        type="button"
                        className="wb-btn-ghost"
                        disabled={busyId === login.id}
                        onClick={() => setConfirmId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="wb-btn-danger"
                        disabled={busyId === login.id}
                        onClick={() => void remove(login)}
                      >
                        {busyId === login.id ? 'Removing…' : 'Remove login'}
                      </button>
                    </div>
                  </div>
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
    const result = await hermesVaultIPC.unlockSource({
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
    const result = await hermesVaultIPC.lockSource({
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
        <button
          type="button"
          className="wb-btn-ghost wb-vault-icon-btn"
          onClick={() => setUnlocking(true)}
        >
          <KeyRound size={14} aria-hidden="true" />
          Unlock
        </button>
      );
    }
  } else {
    pill = <span className="wb-vault-pill is-ok">Unlocked</span>;
    sub = `${loginCount} ${loginCount === 1 ? 'login' : 'logins'} available to ${agentName} until the agent stack restarts.`;
    action = (
      <button
        type="button"
        className="wb-btn-ghost wb-vault-icon-btn"
        disabled={busy}
        onClick={() => void lock()}
      >
        <Lock size={14} aria-hidden="true" />
        Lock
      </button>
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
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            autoFocus
            placeholder={`${source.displayName} master password`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="wb-btn-solid" disabled={busy || !password}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <p className="wb-vault-note">
            Sent to {source.displayName} to unlock it. Boundary and Hermes don’t store it.
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
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEscapeToClose(onCancel, busy);

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || !origin) return;
    setBusy(true);
    setError(null);
    const result = replacing
      ? await hermesVaultIPC.replacePassword({
          agentSlug,
          id: replacing.id,
          password,
        })
      : await hermesVaultIPC.addLogin({
          agentSlug,
          label: labelForOrigin(origin),
          origin,
          identifierType: idType,
          identifier: identifier.trim(),
          password,
        });
    setBusy(false);
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
  };

  return (
    <div className="wb-sheet-backdrop wb-vault-backdrop" role="presentation">
      <form
        className="wb-sheet wb-vault-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-vault-sheet-title"
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="wb-vault-sheet-title">
          {replacing ? `Replace ${replacing.label} password` : `Add a login for ${agentName}`}
        </h2>

        <div className="wb-vault-field">
          <label htmlFor="wb-vault-site">Site</label>
          <input
            id="wb-vault-site"
            value={site}
            disabled={Boolean(replacing) || busy}
            autoFocus={!replacing}
            autoComplete="off"
            placeholder="LinkedIn, or paste the sign-in page URL"
            onChange={(e) => {
              setSite(e.target.value);
              setPickedOrigin(null);
              setKeepTyped(false);
            }}
          />
          {suggestions.length > 0 ? (
            <div className="wb-vault-suggest" role="listbox" aria-label="Known sites">
              {suggestions.map((s) => (
                <button
                  key={s.origin}
                  type="button"
                  role="option"
                  aria-selected="false"
                  onClick={() => pick(s.origin)}
                >
                  <span>{s.name}</span>
                  <span className="mono">{s.origin}</span>
                </button>
              ))}
            </div>
          ) : null}
          {origin && !mismatch ? (
            <p className="wb-vault-origin">
              <Globe size={13} aria-hidden="true" />
              Fills only on <span className="mono">{origin}</span>
            </p>
          ) : null}
          {!origin && suggestions.length === 0 ? (
            <p className="wb-vault-note">
              Use the page where the sign-in form is, not a profile or home page.
            </p>
          ) : null}
          {mismatch && origin ? (
            <div className="wb-vault-warn" role="alert">
              <p>
                {mismatch.name}’s sign-in form is on <span className="mono">{mismatch.origin}</span>
                . A login saved for <span className="mono">{origin}</span> won’t be filled there.
              </p>
              <div className="wb-vault-warn-actions">
                <button
                  type="button"
                  className="wb-btn-solid"
                  onClick={() => pick(mismatch.origin)}
                >
                  Use {hostOf(mismatch.origin)}
                </button>
                <button
                  type="button"
                  className="wb-btn-ghost"
                  onClick={() => {
                    setPickedOrigin(origin);
                    setKeepTyped(true);
                  }}
                >
                  Keep {hostOf(origin)}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="wb-vault-field">
          <span className="wb-vault-field-label" id="wb-vault-idtype">
            Signs in with
          </span>
          <div className="wb-vault-seg" role="group" aria-labelledby="wb-vault-idtype">
            {ID_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                aria-pressed={idType === t.value}
                disabled={Boolean(replacing) || busy}
                onClick={() => setIdType(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="wb-vault-field">
          <label htmlFor="wb-vault-identifier">{idMeta.label}</label>
          <input
            id="wb-vault-identifier"
            ref={identifierRef}
            value={identifier}
            disabled={Boolean(replacing) || busy}
            autoComplete="off"
            placeholder={idMeta.placeholder}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </div>

        <div className="wb-vault-field">
          <label htmlFor="wb-vault-password">{replacing ? 'New password' : 'Password'}</label>
          <div className="wb-vault-password">
            <input
              id="wb-vault-password"
              ref={passwordRef}
              type={showPassword ? 'text' : 'password'}
              value={password}
              disabled={busy}
              autoFocus={Boolean(replacing)}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? (
                <EyeOff size={15} aria-hidden="true" />
              ) : (
                <Eye size={15} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        <p className="wb-vault-lockline">
          <Lock size={13} aria-hidden="true" />
          Saved encrypted in {agentName}’s vault. Boundary can’t show it again, and the model never
          sees it.
        </p>
        {error ? <p className="wb-sheet-error">{error}</p> : null}
        <div className="wb-sheet-actions wb-vault-sheet-actions">
          <button type="button" className="wb-btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="wb-btn-solid" disabled={busy || !ready}>
            {busy ? 'Saving…' : replacing ? 'Replace password' : 'Save login'}
          </button>
        </div>
      </form>
    </div>
  );
}
