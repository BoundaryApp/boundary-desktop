import type { CircleSnapshot } from '../../../../shared/types/circles';
import type {
  SharedFolderChange,
  SharedFolderListing,
  SharedFolderRole,
  UnsharedFile,
} from '../../../../shared/types/sharedFolders';
import { formatBytes } from '../../../../shared/utils/format';

/**
 * How a shared folder stands on this Mac, for the folder view's status strip and the rail's mark
 * (shared folders spec, decision 6): one state at a time, in the order downloading, conflict,
 * waiting for a manager, read-only, up to date.
 */
export type FolderState =
  | { kind: 'not-added' }
  /** Added, but the folder's view hasn't loaded yet. */
  | { kind: 'opening' }
  | { kind: 'downloading'; waiting: number }
  | { kind: 'conflict'; copies: string[] }
  /** Changes that can't be confirmed until these managers' Macs are back. */
  | { kind: 'waiting'; changes: number; managers: string[] }
  | { kind: 'read-only'; unshared: number }
  | { kind: 'up-to-date'; unshared: number };

/** How many managers must see a change: a majority (ADR 0049 §5 as amended). */
function quorum(managers: number): number {
  return Math.floor(managers / 2) + 1;
}

export function folderState(folder: SharedFolderListing, circle?: CircleSnapshot): FolderState {
  if (!folder.local) return { kind: 'not-added' };
  const summary = folder.local.summary;
  if (!summary?.mirror || summary.role === null) return { kind: 'opening' };
  const { waiting, unshared } = summary.mirror;
  if (waiting > 0) return { kind: 'downloading', waiting };
  if (summary.conflicts.length) return { kind: 'conflict', copies: summary.conflicts };
  if (summary.unconfirmed > 0 && circle) {
    const managers = summary.people.filter((person) => person.role === 'manager');
    const online = (identity: string) => circle.members.find((member) => member.identity === identity)?.online ?? false;
    // Only worth saying when too few managers are online to confirm anything.
    if (managers.filter((person) => online(person.identity)).length < quorum(managers.length)) {
      const away = managers.filter((person) => !online(person.identity)).map((person) => personName(circle, person.identity));
      return { kind: 'waiting', changes: summary.unconfirmed, managers: away };
    }
  }
  if (summary.role === 'reader') return { kind: 'read-only', unshared: unshared.length };
  return { kind: 'up-to-date', unshared: unshared.length };
}

/** A person's name as this Circle knows it, "you" for this user. */
export function personName(circle: CircleSnapshot, identity: string, you = 'you'): string {
  const member = circle.members.find((item) => item.identity === identity);
  if (member?.isMe) return you;
  return member?.name ?? 'Someone who left';
}

/** The role new people get: from the folder's view once added, else from the offer. */
export function defaultRole(folder: SharedFolderListing): Exclude<SharedFolderRole, 'manager'> | null {
  return folder.local?.summary?.defaultRole ?? folder.offered?.role ?? null;
}

/** This user's role, or what it will be when they add it. */
export function myRole(folder: SharedFolderListing, circle: CircleSnapshot): SharedFolderRole | null {
  const me = circle.members.find((member) => member.isMe)?.identity;
  if (folder.local?.summary?.role) return folder.local.summary.role;
  if (folder.by === me) return 'manager';
  return defaultRole(folder);
}

/** The folder view's second header line: who shared it and who can change it. */
export function accessLine(folder: SharedFolderListing, circle: CircleSnapshot): string {
  const by = personName(circle, folder.by);
  const role = defaultRole(folder);
  const who = role === 'editor' ? 'everyone can edit' : role === 'reader' ? 'only managers edit' : null;
  const mine = myRole(folder, circle);
  const yours = folder.local ? (mine === 'reader' ? 'you can read' : mine === 'manager' ? 'you manage it' : null) : null;
  return [`Shared by ${by}`, who, yours].filter(Boolean).join(' · ');
}

/**
 * How many managers must be online for changes to confirm (ADR 0049 §5 as amended): a majority of
 * them. `names` are the managers' names, "you" included.
 */
export function quorumLine(names: string[]): string {
  if (names.length <= 1) {
    const [only] = names;
    return only === 'you' || !only ? 'Changes confirm when you are online.' : `Changes confirm when ${only} is online.`;
  }
  const needed = quorum(names.length);
  const which = needed === names.length ? (names.length === 2 ? 'both' : 'all') : `${needed} of ${names.length}`;
  return `${names.length} managers: changes confirm when ${which} have seen them.`;
}

/** "12 files, 3.4 MB", with "about" when a scan stopped early. */
export function sizeLine(files: number, bytes: number, partial = false): string {
  return `${partial ? 'At least ' : ''}${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}, ${formatBytes(bytes)}`;
}

/** Why a file stays on this Mac, in the folder view's words. */
export function unsharedReason(reason: UnsharedFile['reason']): string {
  switch (reason) {
    case 'never-shared':
      return 'Never shared';
    case 'too-large':
      return 'Over 100 MB';
    case 'link':
      return 'Symbolic link';
    case 'reader-change':
      return 'Your change; you can read only';
  }
}

/** What one change did, for an Activity line. */
export function changeVerb(change: SharedFolderChange): 'added' | 'changed' | 'deleted' | 'conflict' {
  if (change.deleted) return 'deleted';
  if (change.conflictOf && change.version === 1) return 'conflict';
  return change.version === 1 ? 'added' : 'changed';
}

/** "Today", "Yesterday" or a date, for Activity's day headings. */
export function dayLabel(at: number, now: number): string {
  const day = (time: number) => new Date(time).toDateString();
  if (day(at) === day(now)) return 'Today';
  if (day(at) === day(now - 86_400_000)) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/** A short time of day, or a date for an older change. */
export function whenLine(at: number, now: number): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel(at, now)} ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/** Which lines of two texts differ, by position (the Resolve sheet marks them; text is never merged). */
export function changedLines(left: string, right: string): [boolean[], boolean[]] {
  const a = left.split('\n');
  const b = right.split('\n');
  return [a.map((line, i) => line !== b[i]), b.map((line, i) => line !== a[i])];
}
