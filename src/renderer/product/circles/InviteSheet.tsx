import React, { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { isOpenInvite, openInvitesNamed } from '../../../shared/circleInvites';
import type { CircleCreatedInvite, CircleInviteView, CircleSnapshot, CirclesState } from '../../../shared/types/circles';
import { CircleButton, TextButton } from './CircleControls';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Sheet } from '../../components/ui/sheet';
import { useAction } from './useCircles';

/**
 * Invites to one Circle. Main keeps a code on the device that made it until the invite is over,
 * and hands it here only when the user asks, so codes stay out of `CirclesState`. A label stays on
 * this device too: other members never see it.
 */

const api = () => window.electronAPI.circles;

function formatExpiry(expires: number, now = Date.now()): string {
  const days = Math.round((expires - now) / (24 * 60 * 60_000));
  if (days >= 2) return `Expires in ${days} days`;
  const hours = Math.max(1, Math.round((expires - now) / (60 * 60_000)));
  return hours >= 24 ? 'Expires tomorrow' : `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export function openInvites(circle: CircleSnapshot, now = Date.now()) {
  return circle.invites.filter((invite) => isOpenInvite(invite, now));
}

/** The start of each code this device keeps for a Circle, by invite id. */
export function useInviteHints(key: string | undefined, keptIds: string[] | undefined): Record<string, string> {
  const [hints, setHints] = useState<Record<string, string>>({});
  const kept = keptIds?.join() ?? '';
  useEffect(() => {
    if (!key || !kept) {
      setHints({});
      return;
    }
    let live = true;
    void api().inviteHints({ key }).then((result) => {
      if (live && result.success) setHints(result.hints);
    });
    return () => {
      live = false;
    };
  }, [key, kept]);
  return hints;
}

export function inviteName(circles: CirclesState, id: string, hints: Record<string, string> = {}): string {
  const label = circles.inviteLabels?.[id];
  const hint = hints[id];
  if (!hint) return label ? `For ${label}` : `Invite ${id.slice(0, 6)}`;
  return label ? `For ${label} · ${hint}…` : `Invite ${hint}…`;
}

/** What the sheet says before a name replaces open invites. */
function replaceNote(replaced: CircleInviteView[], circles: CirclesState): string | null {
  if (!replaced.length) return null;
  const name = circles.inviteLabels?.[replaced[0].id];
  return replaced.length === 1
    ? `Replaces the open code for ${name}. The old code stops working once an admin's device has seen the change.`
    : `Replaces ${replaced.length} open codes for ${name}. The old codes stop working once an admin's device has seen the change.`;
}

function InviteRow({
  circleKey,
  invite,
  name,
  expiry,
  kept,
  action,
  onRevoke,
}: {
  circleKey: string;
  invite: CircleInviteView;
  name: string;
  expiry: string;
  kept: boolean;
  action: ReturnType<typeof useAction>;
  onRevoke: () => void;
}) {
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fetchCode = () => api().inviteCode({ key: circleKey, inviteId: invite.id });
  return (
    <li className="flex flex-col gap-1 text-xs text-fg-muted">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>{name}</span>
        <span className="text-fg-faint">{expiry}</span>
        <span className="ml-auto flex items-center gap-2">
          {kept ? (
            <>
              <TextButton
                disabled={action.busy}
                onClick={() => {
                  if (shown) {
                    setShown(null);
                    return;
                  }
                  void action.run(fetchCode).then((result) => {
                    if (result?.success) setShown(result.code);
                  });
                }}
              >
                {shown ? 'Hide' : 'Show'}
              </TextButton>
              <TextButton
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const result = await fetchCode();
                    if (result.success) {
                      await navigator.clipboard.writeText(result.code);
                      setCopied(true);
                    }
                    return result;
                  })
                }
              >
                {copied ? 'Copied' : 'Copy'}
              </TextButton>
            </>
          ) : null}
          <TextButton disabled={action.busy} onClick={onRevoke}>
            Revoke
          </TextButton>
        </span>
      </div>
      {shown ? (
        <code className="font-mono break-all text-fg" aria-label={`Code ${name}`}>
          {shown}
        </code>
      ) : null}
    </li>
  );
}

/** Who has to be online for a code to work, as a sentence's end: "you or Maya". */
function adminNames(circle: CircleSnapshot): string {
  const names = circle.members
    .filter((member) => member.role === 'admin')
    .sort((a, b) => Number(b.isMe) - Number(a.isMe))
    .map((member) => (member.isMe ? 'you' : member.name));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? 'an admin');
}

export function InviteSheet({
  circle,
  circles,
  hints,
  open,
  onClose,
}: {
  circle: CircleSnapshot;
  circles: CirclesState;
  hints: Record<string, string>;
  open: boolean;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [code, setCode] = useState<CircleCreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const now = Date.now();
  const invites = openInvites(circle, now);
  // A new code can be missing from the snapshot for a moment, so only a known-spent one hides.
  const spent = circle.invites.some((invite) => invite.id === code?.id && (invite.used || invite.revoked));
  const shownCode = code && !spent && code.expires > now ? code : null;
  const replaces = replaceNote(openInvitesNamed(circle, circles.inviteLabels, label, now), circles);
  // A kept code goes back behind Show. One this Mac couldn't keep stays, or it would be lost.
  const close = (): void => {
    if (code?.kept) setCode(null);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={close}
      titleId={`circle-invite-${circle.key}`}
      title={`Invite to ${circle.name}`}
      error={action.error}
      actions={
        <Button variant="outline" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(() => api().createInvite({ key: circle.key, label })).then((result) => {
              if (result?.success) {
                setCode(result.invite);
                setCopied(false);
                setLabel('');
              }
            });
          }}
        >
          <label htmlFor="circle-invite-label" className="text-ui text-fg-muted">
            Who is it for?
          </label>
          <div className="flex gap-2">
            <Input
              id="circle-invite-label"
              className="h-[34px]"
              value={label}
              maxLength={80}
              placeholder="Optional. Only you see this."
              onChange={(event) => setLabel(event.target.value)}
            />
            <CircleButton type="submit" variant="default" disabled={action.busy}>
              Create code
            </CircleButton>
          </div>
          {replaces ? <p className="text-xs text-fg-faint">{replaces}</p> : null}
        </form>
        {shownCode ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-0 px-2.5 py-2">
              <code className="min-w-0 flex-1 font-mono text-xs break-all text-fg" aria-label="Invite code">
                {shownCode.code}
              </code>
              <CircleButton
                size="row"
                variant="default"
                aria-label="Copy invite code"
                onClick={() => void navigator.clipboard.writeText(shownCode.code).then(() => setCopied(true))}
              >
                <Copy className="size-3.5" aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </CircleButton>
            </div>
            <p className="text-xs text-fg-faint">
              {shownCode.kept
                ? 'Copy it again from the list below until it’s used, revoked or expired.'
                : 'This Mac couldn’t keep the code, so copy it now.'}
            </p>
            {shownCode.stillOpen ? (
              <p className="text-xs text-danger">The earlier code for this name is still open. Revoke it below.</p>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-fg-faint">
          Each code lets one person in, once. An admin has to be online when they use it: {adminNames(circle)}.
        </p>
        {invites.length ? (
          <ul aria-label="Open invites" className="flex flex-col gap-1 border-t border-line pt-2">
            {invites.map((invite) => (
              <InviteRow
                key={invite.id}
                circleKey={circle.key}
                invite={invite}
                name={inviteName(circles, invite.id, hints)}
                expiry={formatExpiry(invite.expires, now)}
                kept={Boolean(hints[invite.id])}
                action={action}
                onRevoke={() => {
                  if (code?.id === invite.id) setCode(null);
                  void action.run(() => api().revokeInvite({ key: circle.key, inviteId: invite.id }));
                }}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}
