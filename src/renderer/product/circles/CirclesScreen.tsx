import React, { useEffect, useState } from 'react';
import type {
  CircleMemberView,
  CircleOfferView,
  CircleSnapshot,
  CirclesState,
} from '../../../shared/types/circles';
import { Callout } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Sheet, SheetConfirmActions } from '../../components/ui/sheet';
import { Avatar, CircleButton, CirclePill, TextButton } from './CircleControls';
import { CircleSharingPanel, MyShareRow, useCanShare } from './CircleSharingPanel';
import { CircleOffers } from './CircleOffers';
import { CirclesNav, resolveSelection, type CirclesSelection } from './CirclesNav';
import { InviteSheet, inviteName, openInvites, useInviteHints } from './InviteSheet';
import { PersonPanel } from './PersonPanel';
import { useAction, useCirclesState } from './useCircles';
import { APP_NAME } from '../../../shared/buildIdentity';

/**
 * Circles (ADR 0032): invite-only groups whose members' Macs connect directly. Create one, invite
 * with a code, join with a code, and manage members. A Circle is reachable while one of its
 * members has Boundary open; invites need an admin online.
 */

const api = () => window.electronAPI.circles;

export function NameForm({ current, onSaved }: { current: string; onSaved?: () => void }) {
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

/** `onJoin` hands the code to the Circles screen, which shows the wait on its own page. */
export function JoinForm({ onJoin }: { onJoin?: (code: string) => void }) {
  const [code, setCode] = useState('');
  const join = useAction();
  return (
    <form
      aria-label="Join a Circle"
      className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-1 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (onJoin) {
          onJoin(code);
          return;
        }
        void join.run(() => api().join({ code })).then((result) => {
          if (result?.success) setCode('');
        });
      }}
    >
      <span className="text-title font-medium text-fg">Join with an invite</span>
      <span className="text-xs text-fg-faint">Paste the code someone sent you.</span>
      <Input className="h-[34px] bg-surface-0" aria-label="Invite code" placeholder="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />
      <CircleButton type="submit" variant="outline" disabled={join.busy || !code.trim()}>
        {join.busy ? 'Joining…' : 'Join'}
      </CircleButton>
      {join.busy ? (
        <p className="text-xs text-fg-faint">
          This finishes on its own once one of the Circle&apos;s admins has {APP_NAME} open. Keep {APP_NAME} open.
        </p>
      ) : null}
      {join.error ? <p className="text-xs text-danger">{join.error}</p> : null}
    </form>
  );
}

function StartForms({
  stacked = false,
  onCreated,
  onJoin,
}: {
  stacked?: boolean;
  onCreated: (key: string) => void;
  onJoin: (code: string) => void;
}) {
  const [name, setName] = useState('');
  const create = useAction();
  return (
    <div className={`grid gap-4${stacked ? '' : ' md:grid-cols-2'}`}>
      <form
        aria-label="Start a Circle"
        className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-1 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create.run(() => api().create({ name })).then((result) => {
            if (result?.success) {
              setName('');
              onCreated(result.key);
            }
          });
        }}
      >
        <span className="text-title font-medium text-fg">Start a Circle</span>
        <span className="text-xs text-fg-faint">You&apos;ll be its admin and can invite people.</span>
        <Input className="h-[34px] bg-surface-0" aria-label="Circle name" placeholder="Circle name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <CircleButton type="submit" variant="default" disabled={create.busy || !name.trim()}>
          {create.busy ? 'Creating…' : 'Create'}
        </CircleButton>
        {create.error ? <p className="text-xs text-danger">{create.error}</p> : null}
      </form>
      <JoinForm onJoin={onJoin} />
    </div>
  );
}

function Welcome({
  circles,
  onCreated,
  onJoin,
}: {
  circles: CirclesState;
  onCreated: (key: string) => void;
  onJoin: (code: string) => void;
}) {
  return (
    <div className="mx-auto mt-16 flex w-full max-w-[680px] flex-col gap-6">
      <header>
        <h1 className="text-heading font-medium text-fg">Share a model with people you know</h1>
        <p className="mt-2 text-ui text-fg-muted">
          A Circle is a small invite-only group. Members&apos; Macs connect to each other directly, with no server in
          between, while {APP_NAME} is open.
        </p>
      </header>
      {circles.displayName ? <StartForms onCreated={onCreated} onJoin={onJoin} /> : <NameForm current="" />}
    </div>
  );
}

/** `admitted` is the moment before the Circle reaches the list, when there's nothing to cancel. */
function JoinPage({ error, admitted }: { error?: string; admitted: boolean }) {
  const cancel = useAction();
  return (
    <div className="mx-auto mt-[120px] flex w-full max-w-[460px] flex-col items-center gap-2.5 text-center">
      <h1 className="text-heading font-medium text-fg">{error ? 'Couldn’t join' : 'Joining the Circle'}</h1>
      {error ? (
        <Callout variant="destructive">{error}</Callout>
      ) : (
        <p className="text-ui text-fg-muted">
          This finishes on its own once one of the Circle&apos;s admins has {APP_NAME} open. They don&apos;t need to do
          anything. Keep {APP_NAME} open.
        </p>
      )}
      {admitted ? null : (
        <CircleButton variant="outline" className="mt-2" disabled={cancel.busy} onClick={() => void cancel.run(() => api().cancelJoin())}>
          {error ? 'Dismiss' : 'Cancel'}
        </CircleButton>
      )}
      {cancel.error ? <p className="text-xs text-danger">{cancel.error}</p> : null}
    </div>
  );
}

function ProfileSheet({ circles, open, onClose }: { circles: CirclesState; open: boolean; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId="circles-profile"
      title="Profile"
      error={error}
      actions={
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <NameForm current={circles.displayName} />
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() =>
            void api().revealDiagnostics().then((result) => {
              setError(result.success ? null : (result.error ?? 'Couldn’t show the file.'));
            })
          }
        >
          Show diagnostics file
        </Button>
      </div>
    </Sheet>
  );
}

type Pending =
  | { kind: 'remove'; member: CircleMemberView }
  | { kind: 'leave' }
  | { kind: 'delete' };

function confirmCopy(pending: Pending | null, circle: CircleSnapshot, busy: boolean) {
  if (pending?.kind === 'delete') {
    return {
      title: `Delete ${circle.name}?`,
      label: busy ? 'Deleting…' : 'Delete Circle',
      help: 'You’re its only member, so this ends the Circle and you can’t get it back. Anyone removed earlier keeps what they already received.',
    };
  }
  if (pending?.kind === 'leave') {
    return {
      title: `Leave ${circle.name}?`,
      label: busy ? 'Leaving…' : 'Leave',
      help: 'You stop receiving anything new from this Circle. What you’ve already received stays on this Mac.',
    };
  }
  return {
    title: `Remove ${pending?.member.name ?? ''}?`,
    label: busy ? 'Removing…' : 'Remove',
    help: 'They stop receiving anything new from this Circle. What they’ve already received stays with them.',
  };
}

/** Green means the person's model can be used now; without a model, that they're online. */
function presence(member: CircleMemberView, offer: CircleOfferView | undefined): { dot: string; label: string } {
  if (!member.online) return { dot: 'bg-line', label: 'Offline' };
  if (offer && !offer.available) return { dot: 'bg-warn', label: 'Paused' };
  return { dot: 'bg-ok', label: 'Online' };
}

function PersonRow({
  circle,
  member,
  circles,
  open,
  onOpen,
}: {
  circle: CircleSnapshot;
  member: CircleMemberView;
  circles: CirclesState;
  open: boolean;
  onOpen: () => void;
}) {
  const offer = member.isMe ? undefined : circle.offers.find((item) => item.identity === member.identity);
  const { dot, label } = presence(member, offer);
  const trusted = circles.providers[member.identity]?.trusted === true;
  const models = offer?.models.map((model) => model.id).join(', ');
  const body = (
    <>
      <Avatar name={member.name} dot={dot} label={label} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-ui text-fg">{member.name}</span>
          {member.isMe ? <span className="text-xs text-fg-faint">you</span> : null}
          {member.role === 'admin' ? <CirclePill tone="tag">Admin</CirclePill> : null}
          {offer?.away ? <CirclePill tone="tag">Away mode</CirclePill> : null}
        </span>
        <span className="text-xs break-words text-fg-faint">{models ? (member.online ? models : `${models} · offline`) : label}</span>
      </span>
      {offer ? <CirclePill tone={trusted ? 'ok' : 'warn'}>{trusted ? 'Trusted' : 'Not trusted'}</CirclePill> : null}
    </>
  );
  return (
    <li>
      {member.isMe ? (
        <div className="flex min-h-[58px] items-center gap-3 px-2.5">{body}</div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={onOpen}
          className={`flex min-h-[58px] w-full cursor-pointer items-center gap-3 px-2.5 text-left hover:bg-surface-hover${open ? ' bg-surface-1' : ''}`}
        >
          {body}
        </button>
      )}
    </li>
  );
}

function CirclePage({
  circle,
  circles,
  hints,
  person,
  onPerson,
  onLeave,
  onInvite,
}: {
  circle: CircleSnapshot;
  circles: CirclesState;
  hints: Record<string, string>;
  person: string | null;
  onPerson: (identity: string) => void;
  /** Leaving, or deleting when the user is the last member. */
  onLeave: (alone: boolean) => void;
  onInvite: () => void;
}) {
  const canShare = useCanShare(circles);
  const online = circle.members.filter((member) => member.online).length;
  const others = circle.members.filter((member) => !member.isMe);
  const me = circle.members.find((member) => member.isMe);
  const alone = circle.members.length === 1 && Boolean(me);
  const invites = circle.myRole === 'admin' ? openInvites(circle) : [];
  return (
    <section aria-label={circle.name || 'Circle'} className="flex flex-col gap-5">
      <header className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <h1 className="text-heading leading-[1.2] font-medium text-fg">{circle.name || 'Joining…'}</h1>
          <p className="mt-1.5 text-xs text-fg-faint">
            {circle.members.length} {circle.members.length === 1 ? 'member' : 'members'} · {online} online · invites work while
            an admin is online
          </p>
        </span>
        {circle.myRole === 'admin' ? (
          <CircleButton variant="default" onClick={onInvite}>
            Invite someone
          </CircleButton>
        ) : null}
        <CircleButton variant="outline" disabled={!circle.writable} onClick={() => onLeave(alone)}>
          {alone ? 'Delete Circle' : 'Leave'}
        </CircleButton>
      </header>
      <ul aria-label="People" className="flex flex-col divide-y divide-line border-t border-line">
        {canShare ? (
          <MyShareRow circle={circle} circles={circles} />
        ) : me ? (
          <PersonRow circle={circle} member={me} circles={circles} open={false} onOpen={() => undefined} />
        ) : null}
        {others.map((member) => (
          <PersonRow
            key={member.identity}
            circle={circle}
            member={member}
            circles={circles}
            open={person === member.identity}
            onOpen={() => onPerson(member.identity)}
          />
        ))}
      </ul>
      {circle.writable ? null : (
        <p role="status" className="text-xs text-fg-faint">
          {circles.finishingJoin === circle.key
            ? 'Finishing joining'
            : 'Finishing joining is taking longer than usual. You can read this Circle now, and you can change things in it once this Mac has caught up.'}
        </p>
      )}
      {circle.needsUpdate ? (
        <Callout variant="warn">This Circle moved to a newer format. Update the app to see its changes and write to it.</Callout>
      ) : null}
      {invites.length ? (
        <p className="flex items-center gap-3 rounded-md border border-dashed border-line px-3 py-2.5 text-xs text-fg-muted">
          <span className="min-w-0 flex-1">
            {inviteName(circles, invites[0].id, hints)}
            {invites.length > 1 ? ` and ${invites.length - 1} more waiting to be used` : ', waiting to be used'}
          </span>
          <TextButton onClick={onInvite}>Manage</TextButton>
        </p>
      ) : null}
    </section>
  );
}

function ConfirmSheet({ circle, pending, onClose }: { circle: CircleSnapshot; pending: Pending | null; onClose: () => void }) {
  const confirm = useAction();
  const copy = confirmCopy(pending, circle, confirm.busy);
  const run = async () => {
    if (!pending) return;
    const result = await confirm.run(() => {
      if (pending.kind === 'delete') return api().delete({ key: circle.key });
      if (pending.kind === 'leave') return api().leave({ key: circle.key });
      return api().removeMember({ key: circle.key, identity: pending.member.identity });
    });
    if (result?.success) onClose();
  };
  return (
    <Sheet
      open={pending !== null}
      onClose={() => {
        confirm.setError(null);
        onClose();
      }}
      busy={confirm.busy}
      titleId={`circle-confirm-${circle.key}`}
      title={copy.title}
      error={confirm.error}
      actions={
        <SheetConfirmActions
          busy={confirm.busy}
          onCancel={onClose}
          tone="danger"
          confirmLabel={copy.label}
          onConfirm={() => void run()}
        />
      }
    >
      <p className="wb-sheet-help">{copy.help}</p>
    </Sheet>
  );
}

export const CirclesScreen: React.FC<{
  selection: CirclesSelection;
  onSelect: (selection: CirclesSelection) => void;
}> = ({ selection, onSelect }) => {
  const state = useCirclesState();
  const [sheet, setSheet] = useState<'add' | 'profile' | 'invite' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const selected = resolveSelection(selection, state);
  const circle = selected?.kind === 'circle' ? state.snapshot.circles.find((item) => item.key === selected.key) : null;
  const hints = useInviteHints(circle?.key, state.inviteCodeIds);
  // A person who has left the Circle closes their panel.
  const inView = circle ? [circle] : state.snapshot.circles;
  const person = selected?.kind === 'joining' ? undefined : selected?.person;
  const member = inView.flatMap((item) => item.members).find((item) => item.identity === person && !item.isMe) ?? null;
  const setPerson = (identity?: string): void => {
    if (selected && selected.kind !== 'joining') onSelect({ ...selected, person: identity });
  };
  const ready = (key: string): void => {
    setSheet(null);
    onSelect({ kind: 'circle', key });
  };
  const startJoin = (code: string): void => {
    setSheet(null);
    onSelect({ kind: 'joining' });
    void api().join({ code });
  };
  // Admission moves the page to the Circle. Someone who has gone elsewhere stays there.
  const admitted = state.finishingJoin && state.snapshot.circles.some((item) => item.key === state.finishingJoin) ? state.finishingJoin : null;
  const onJoinPage = selected?.kind === 'joining';
  useEffect(() => {
    if (admitted && onJoinPage) onSelect({ kind: 'circle', key: admitted });
  }, [admitted, onJoinPage, onSelect]);
  return (
    <div className="wb-circles flex min-h-0 flex-1">
      <CirclesNav
        circles={state}
        selected={selected}
        onSelect={onSelect}
        onAdd={() => setSheet('add')}
        onProfile={() => setSheet('profile')}
      />
      <div className="wb-circles-page min-w-0 flex-1 overflow-y-auto">
        <div className={`flex max-w-[760px] flex-col ${selected?.kind === 'sharing' ? 'gap-6' : 'gap-5'}`}>
          {state.status === 'failed' && state.error ? <Callout variant="destructive">{state.error}</Callout> : null}
          {selected === null ? <Welcome circles={state} onCreated={ready} onJoin={startJoin} /> : null}
          {selected?.kind === 'joining' ? <JoinPage error={state.join?.error} admitted={Boolean(state.finishingJoin)} /> : null}
          {selected?.kind === 'sharing' ? (
            <>
              <h1 className="text-heading leading-[1.2] font-medium text-fg">Sharing</h1>
              <CircleSharingPanel circles={state} />
              <CircleOffers circles={state} person={member?.identity ?? null} onPerson={setPerson} />
            </>
          ) : null}
          {circle ? (
            <CirclePage
              key={circle.key}
              circle={circle}
              circles={state}
              hints={hints}
              person={member?.identity ?? null}
              onPerson={setPerson}
              onLeave={(alone) => setPending({ kind: alone ? 'delete' : 'leave' })}
              onInvite={() => setSheet('invite')}
            />
          ) : null}
        </div>
      </div>
      {member ? (
        <PersonPanel
          circles={state}
          circle={circle}
          member={member}
          onClose={() => setPerson()}
          onRemove={(target) => setPending({ kind: 'remove', member: target })}
        />
      ) : null}
      {circle ? <ConfirmSheet key={circle.key} circle={circle} pending={pending} onClose={() => setPending(null)} /> : null}
      <Sheet
        open={sheet === 'add'}
        onClose={() => setSheet(null)}
        titleId="circles-add"
        title="Add a Circle"
        actions={
          <Button variant="outline" onClick={() => setSheet(null)}>
            Close
          </Button>
        }
      >
        <StartForms stacked onCreated={ready} onJoin={startJoin} />
      </Sheet>
      {circle ? <InviteSheet key={`invite-${circle.key}`} circle={circle} circles={state} hints={hints} open={sheet === 'invite'} onClose={() => setSheet(null)} /> : null}
      <ProfileSheet circles={state} open={sheet === 'profile'} onClose={() => setSheet(null)} />
    </div>
  );
};
