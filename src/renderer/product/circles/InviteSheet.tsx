import React, { useState } from 'react';
import { Copy } from 'lucide-react';
import type { CircleSnapshot, CirclesState } from '../../../shared/types/circles';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Sheet } from '../../components/ui/sheet';
import { useAction } from './useCircles';

/**
 * Invites to one Circle. A code exists only when it's made, so this sheet is the one place it
 * shows. A label stays on this device: other members never see it.
 */

const api = () => window.electronAPI.circles;

function formatExpiry(expires: number, now = Date.now()): string {
  const days = Math.round((expires - now) / (24 * 60 * 60_000));
  if (days >= 2) return `Expires in ${days} days`;
  const hours = Math.max(1, Math.round((expires - now) / (60 * 60_000)));
  return hours >= 24 ? 'Expires tomorrow' : `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export function openInvites(circle: CircleSnapshot, now = Date.now()) {
  return circle.invites.filter((invite) => !invite.used && !invite.revoked && invite.expires > now);
}

export function inviteName(circles: CirclesState, id: string): string {
  const label = circles.inviteLabels?.[id];
  return label ? `For ${label}` : `Invite ${id.slice(0, 6)}`;
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
  open,
  onClose,
}: {
  circle: CircleSnapshot;
  circles: CirclesState;
  open: boolean;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [code, setCode] = useState<{ id: string; code: string; expires: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const now = Date.now();
  const invites = openInvites(circle, now);
  // A new code can be missing from the snapshot for a moment, so only a known-spent one hides.
  const spent = circle.invites.some((invite) => invite.id === code?.id && (invite.used || invite.revoked));
  const shownCode = code && !spent && code.expires > now ? code : null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      titleId={`circle-invite-${circle.key}`}
      title={`Invite to ${circle.name}`}
      error={action.error}
      actions={
        <Button variant="outline" onClick={onClose}>
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
              value={label}
              maxLength={80}
              placeholder="Optional. Only you see this."
              onChange={(event) => setLabel(event.target.value)}
            />
            <Button type="submit" variant="outline" disabled={action.busy}>
              Create code
            </Button>
          </div>
        </form>
        {shownCode ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-0 p-2">
              <code className="min-w-0 flex-1 break-all text-xs text-fg" aria-label="Invite code">
                {shownCode.code}
              </code>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Copy invite code"
                onClick={() => void navigator.clipboard.writeText(shownCode.code).then(() => setCopied(true))}
              >
                <Copy className="size-4" aria-hidden />
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-fg-faint">Copy it now: it can't be shown again.</p>
          </div>
        ) : null}
        <p className="text-xs text-fg-faint">
          Each code lets one person in, once. An admin has to be online when they use it: {adminNames(circle)}.
        </p>
        {invites.length ? (
          <ul aria-label="Open invites" className="flex flex-col gap-1 border-t border-line pt-2">
            {invites.map((invite) => (
              <li key={invite.id} className="flex items-center gap-2 text-xs text-fg-muted">
                <span>{inviteName(circles, invite.id)}</span>
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
      </div>
    </Sheet>
  );
}
