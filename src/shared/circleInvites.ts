import type { CircleInviteView, CircleSnapshot } from './types/circles';

export function isOpenInvite(invite: CircleInviteView, now = Date.now()): boolean {
  return !invite.used && !invite.revoked && invite.expires > now;
}

const inviteNameKey = (name: string): string => name.trim().toLowerCase();

/** This Circle's open invites the user gave `name`, ignoring case and surrounding spaces. */
export function openInvitesNamed(
  circle: CircleSnapshot | undefined,
  labels: Record<string, string> | undefined,
  name: string,
  now = Date.now()
): CircleInviteView[] {
  const wanted = inviteNameKey(name);
  if (!circle || !wanted) return [];
  return circle.invites.filter(
    (invite) => isOpenInvite(invite, now) && labels?.[invite.id] !== undefined && inviteNameKey(labels[invite.id]) === wanted
  );
}
