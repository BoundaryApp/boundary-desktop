import React, { useState } from 'react';
import { Copy } from 'lucide-react';
import type {
  CircleMemberView,
  CircleOfferView,
  CircleProviderSettings,
  CircleSnapshot,
  CirclesResult,
} from '../../../shared/types/circles';
import { Callout } from '../../components/ui/alert';
import { Pill } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { resultError, useCirclesState } from './useCircles';

/**
 * Circles (ADR 0032): invite-only groups whose members' Macs connect directly. Create one, invite
 * with a code, join with a code, and manage members. A Circle is reachable while one of its
 * members has Boundary open; invites need an admin online.
 */

const api = () => window.electronAPI.circles;

/** Runs a Circles call with a busy flag and the error it returns. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T extends object>(call: () => Promise<CirclesResult<T>>): Promise<CirclesResult<T> | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      setError(resultError(result));
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

function formatExpiry(expires: number, now = Date.now()): string {
  const days = Math.round((expires - now) / (24 * 60 * 60_000));
  if (days >= 2) return `Expires in ${days} days`;
  const hours = Math.max(1, Math.round((expires - now) / (60 * 60_000)));
  return hours >= 24 ? 'Expires tomorrow' : `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function NameForm({ current, onSaved }: { current: string; onSaved?: () => void }) {
  const [name, setName] = useState(current);
  const action = useAction();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(() => api().setDisplayName({ name })).then((result) => {
          if (result?.success) onSaved?.();
        });
      }}
    >
      <label htmlFor="circles-name" className="text-ui text-fg">
        Your name in Circles
      </label>
      <div className="flex gap-2">
        <Input id="circles-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" variant="outline" disabled={action.busy || !name.trim()}>
          Save
        </Button>
      </div>
      <p className="text-xs text-fg-faint">Members of your Circles see this name. A new name reaches Circles you join after changing it.</p>
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </form>
  );
}

function StartForms() {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const create = useAction();
  const join = useAction();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <form
        aria-label="New Circle"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create.run(() => api().create({ name })).then((result) => {
            if (result?.success) setName('');
          });
        }}
      >
        <span className="font-medium text-fg">New Circle</span>
        <Input aria-label="Circle name" placeholder="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="outline" disabled={create.busy || !name.trim()}>
          {create.busy ? 'Creating…' : 'Create'}
        </Button>
        {create.error ? <p className="text-xs text-danger">{create.error}</p> : null}
      </form>
      <form
        aria-label="Join a Circle"
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void join.run(() => api().join({ code })).then((result) => {
            if (result?.success) setCode('');
          });
        }}
      >
        <span className="font-medium text-fg">Join with an invite</span>
        <Input aria-label="Invite code" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
        <Button type="submit" variant="outline" disabled={join.busy || !code.trim()}>
          {join.busy ? 'Waiting for an admin…' : 'Join'}
        </Button>
        {join.busy ? (
          <p className="text-xs text-fg-faint">An admin of the Circle has to be online to let you in. Keep Boundary open.</p>
        ) : null}
        {join.error ? <p className="text-xs text-danger">{join.error}</p> : null}
      </form>
    </div>
  );
}

type Pending =
  | { kind: 'remove'; member: CircleMemberView }
  | { kind: 'leave' };

function MemberRow({
  circle,
  member,
  onRemove,
}: {
  circle: CircleSnapshot;
  member: CircleMemberView;
  onRemove: (member: CircleMemberView) => void;
}) {
  const action = useAction();
  const admin = circle.myRole === 'admin';
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      <span
        className={`size-2 rounded-full ${member.online ? 'bg-ok' : 'bg-line'}`}
        role="img"
        aria-label={member.online ? 'Online' : 'Offline'}
      />
      <span className="text-ui text-fg">{member.name}</span>
      {member.isMe ? <span className="text-xs text-fg-faint">you</span> : null}
      {member.role === 'admin' ? <Pill variant="outline">Admin</Pill> : null}
      {admin && !member.isMe ? (
        <span className="ml-auto flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={action.busy}
            onClick={() =>
              void action.run(() =>
                api().setRole({ key: circle.key, identity: member.identity, role: member.role === 'admin' ? 'member' : 'admin' })
              )
            }
          >
            {member.role === 'admin' ? 'Make member' : 'Make admin'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onRemove(member)}>
            Remove
          </Button>
        </span>
      ) : null}
      {action.error ? <p className="w-full text-xs text-danger">{action.error}</p> : null}
    </li>
  );
}

function InvitePanel({ circle }: { circle: CircleSnapshot }) {
  const [code, setCode] = useState<{ id: string; code: string; expires: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const now = Date.now();
  const open = circle.invites.filter((invite) => !invite.used && !invite.revoked && invite.expires > now);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={action.busy}
          onClick={() =>
            void action.run(() => api().createInvite({ key: circle.key })).then((result) => {
              if (result?.success) {
                setCode(result.invite);
                setCopied(false);
              }
            })
          }
        >
          Invite someone
        </Button>
        <span className="text-xs text-fg-faint">Each code lets one person in, while an admin is online.</span>
      </div>
      {code ? (
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface-0 p-2">
          <code className="min-w-0 flex-1 break-all text-xs text-fg" aria-label="Invite code">
            {code.code}
          </code>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Copy invite code"
            onClick={() => void navigator.clipboard.writeText(code.code).then(() => setCopied(true))}
          >
            <Copy className="size-4" aria-hidden />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      ) : null}
      {open.length ? (
        <ul aria-label="Open invites" className="flex flex-col gap-1">
          {open.map((invite) => (
            <li key={invite.id} className="flex items-center gap-2 text-xs text-fg-muted">
              <span>Invite {invite.id.slice(0, 6)}</span>
              <span className="text-fg-faint">{formatExpiry(invite.expires, now)}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={action.busy}
                onClick={() => {
                  if (code?.id === invite.id) setCode(null);
                  void action.run(() => api().revokeInvite({ key: circle.key, inviteId: invite.id }));
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </div>
  );
}

const NO_SETTINGS: CircleProviderSettings = { private: false, trusted: false };

/** One of the two claims a user makes about a provider (ADR 0034 §3). */
function ProviderSwitch({
  label,
  detail,
  on,
  disabled,
  onToggle,
}: {
  label: string;
  detail: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={`wb-switch shrink-0${on ? ' is-on' : ''}`}
      >
        <i />
      </button>
      <span className="flex flex-col">
        <span className="text-ui text-fg">{label}</span>
        <span className="text-xs text-fg-faint">{detail}</span>
      </span>
    </div>
  );
}

function OfferRow({ offer, settings }: { offer: CircleOfferView; settings: CircleProviderSettings }) {
  const action = useAction();
  const save = (next: CircleProviderSettings): void => {
    void action.run(() => api().setProviderSettings({ identity: offer.identity, ...next }));
  };
  const models = offer.models.map((model) => model.id).join(', ');
  return (
    <li className="flex flex-col gap-2 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`size-2 rounded-full ${offer.online ? 'bg-ok' : 'bg-line'}`}
          role="img"
          aria-label={offer.online ? 'Online' : 'Offline'}
        />
        <span className="text-ui text-fg">{offer.isMine ? 'You' : offer.name}</span>
        <span className="min-w-0 text-xs break-words text-fg-muted">{models}</span>
        {!offer.available ? <Pill variant="outline">Paused</Pill> : null}
        {offer.away ? <Pill variant="outline">Away mode</Pill> : null}
      </div>
      {offer.isMine ? null : (
        <div className="flex flex-col gap-2 pl-4">
          <ProviderSwitch
            label="Trusted"
            detail={
              settings.trusted
                ? `You accept that ${offer.name}'s model can run your agent's tools. Their models can serve your chats.`
                : `Until you trust ${offer.name}, their models are skipped in your chains, because a reply can make your agent run tools.`
            }
            on={settings.trusted}
            disabled={action.busy}
            onToggle={() => save({ ...settings, trusted: !settings.trusted })}
          />
          <ProviderSwitch
            label="Private"
            detail={
              settings.private
                ? `You accept that ${offer.name} can read your prompts, so their models can serve private projects.`
                : `${offer.name}'s Mac sees every prompt it serves. Off: private projects never send to them.`
            }
            on={settings.private}
            disabled={action.busy}
            onToggle={() => save({ ...settings, private: !settings.private })}
          />
          <p className="text-xs text-fg-faint">
            Boundary can't check either. Both apply to {offer.name} in every Circle you share.
          </p>
        </div>
      )}
      {action.error ? <p className="text-xs text-danger">{action.error}</p> : null}
    </li>
  );
}

function SharedModels({ circle, providers }: { circle: CircleSnapshot; providers: Record<string, CircleProviderSettings> }) {
  if (!circle.offers.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-ui font-medium text-fg">Shared models</h3>
      <ul aria-label="Shared models" className="flex flex-col divide-y divide-line">
        {circle.offers.map((offer) => (
          <OfferRow key={offer.identity} offer={offer} settings={providers[offer.identity] ?? NO_SETTINGS} />
        ))}
      </ul>
    </div>
  );
}

function CircleCard({ circle, providers }: { circle: CircleSnapshot; providers: Record<string, CircleProviderSettings> }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useAction();
  const online = circle.members.filter((member) => member.online && !member.isMe).length;

  const runPending = async () => {
    if (!pending) return;
    const result = await confirm.run(() =>
      pending.kind === 'leave'
        ? api().leave({ key: circle.key })
        : api().removeMember({ key: circle.key, identity: pending.member.identity })
    );
    if (result?.success) setPending(null);
  };

  return (
    <section aria-label={circle.name || 'Circle'} className="flex flex-col gap-3 rounded-lg border border-line bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-medium text-fg">{circle.name || 'Joining…'}</h2>
        {circle.myRole === 'admin' ? <Pill variant="brand">Admin</Pill> : null}
        <span className="text-xs text-fg-faint">
          {circle.members.length} {circle.members.length === 1 ? 'member' : 'members'} · {online} online
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setPending({ kind: 'leave' })}>
          Leave
        </Button>
      </div>
      <ul aria-label="Members" className="flex flex-col divide-y divide-line">
        {circle.members.map((member) => (
          <MemberRow key={member.identity} circle={circle} member={member} onRemove={(m) => setPending({ kind: 'remove', member: m })} />
        ))}
      </ul>
      <SharedModels circle={circle} providers={providers} />
      {circle.myRole === 'admin' ? <InvitePanel circle={circle} /> : null}

      <Sheet
        open={pending !== null}
        onClose={() => {
          confirm.setError(null);
          setPending(null);
        }}
        busy={confirm.busy}
        titleId={`circle-confirm-${circle.key}`}
        title={pending?.kind === 'leave' ? `Leave ${circle.name}?` : `Remove ${pending?.kind === 'remove' ? pending.member.name : ''}?`}
        error={confirm.error}
        actions={
          <SheetConfirmActions
            busy={confirm.busy}
            onCancel={() => setPending(null)}
            tone="danger"
            confirmLabel={pending?.kind === 'leave' ? (confirm.busy ? 'Leaving…' : 'Leave') : confirm.busy ? 'Removing…' : 'Remove'}
            onConfirm={() => void runPending()}
          />
        }
      >
        <p className="wb-sheet-help">
          {pending?.kind === 'leave'
            ? 'You stop receiving anything new from this Circle. What you’ve already received stays on this Mac.'
            : 'They stop receiving anything new from this Circle. What they’ve already received stays with them.'}
        </p>
      </Sheet>
    </section>
  );
}

export const CirclesScreen: React.FC = () => {
  const state = useCirclesState();
  const [renaming, setRenaming] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const named = Boolean(state.displayName);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-10">
      <div className="flex max-w-[960px] flex-col gap-5">
        <header>
          <h1 className="text-heading font-medium text-fg">Circles</h1>
          <p className="mt-1.5 text-xs text-fg-faint">
            Small invite-only groups whose Macs connect to each other directly, with no server in between. A Circle is
            reachable while one of its members has Boundary open.
          </p>
        </header>

        {state.status === 'failed' && state.error ? <Callout variant="destructive">{state.error}</Callout> : null}

        {!named || renaming ? (
          <NameForm current={state.displayName} onSaved={() => setRenaming(false)} />
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-ui text-fg-muted">
            <span>
              You appear as <b className="font-medium text-fg">{state.displayName}</b>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
              Change
            </Button>
            {state.status === 'starting' ? <Pill dot>Connecting</Pill> : null}
            {state.status === 'running' ? (
              <Pill variant="ok" dot>
                Connected
              </Pill>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() =>
                void window.electronAPI.circles.revealDiagnostics().then((result) => {
                  setDiagnosticsError(result.success ? null : (result.error ?? 'Couldn’t show the file.'));
                })
              }
            >
              Show diagnostics file
            </Button>
          </div>
        )}

        {diagnosticsError ? <p className="text-xs text-danger">{diagnosticsError}</p> : null}

        {named ? <StartForms /> : null}

        {state.snapshot.circles.map((circle) => (
          <CircleCard key={circle.key} circle={circle} providers={state.providers} />
        ))}
      </div>
    </div>
  );
};
