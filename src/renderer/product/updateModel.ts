import type { UpdateSnapshot } from '../../shared/types/updates';
import { APP_NAME } from '../../shared/buildIdentity';

/**
 * Where an update stands, in the words the update card, the rail button and Settings → Updates
 * share. Each of them chooses a layout for the description; none of them reads the snapshot's
 * fields to decide what to say.
 */
export type UpdateStage =
  | 'blocked-folder'
  | 'needs-key'
  | 'key-rejected'
  | 'no-feed'
  | 'last-call'
  | 'waiting'
  | 'updated'
  | 'ready'
  | 'downloading'
  | 'failed'
  | 'available'
  | 'check-failed'
  | 'current';

/** What each action does; the card and the page each wire these to the update bridge. */
export type UpdateActionId =
  | 'move-to-applications'
  | 'restart-now'
  | 'cancel-waiting'
  | 'see-what-changed'
  | 'restart-to-update'
  | 'download'
  | 'skip'
  | 'check';

export interface UpdateAction {
  id: UpdateActionId;
  label: string;
  primary?: boolean;
  disabled?: boolean;
}

export interface UpdateDescription {
  stage: UpdateStage;
  tone: 'ok' | 'brand' | 'warn';
  title: string;
  body: string;
  /** A second sentence the card sets apart and the page runs on after `body`. */
  note: string | null;
  /** The download size or progress, shown beside the title on the card. */
  detail: string | null;
  /** What's new lines, which the card shows in place of `body`. */
  lines: string[];
  actions: UpdateAction[];
}

/** Decimal units, as the feed's sizes have always been shown. */
function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/** At 100 every byte is in, and Squirrel is checking the update and unpacking it. */
function downloadTitle(state: UpdateSnapshot): string {
  const verb = state.downloadPercent === 100 ? 'Checking' : 'Downloading';
  return `${verb} ${APP_NAME} ${state.version}`;
}

/** The percent while one is known, otherwise the size alone. */
function downloadDetail({ downloadPercent: percent, size }: UpdateSnapshot): string | null {
  if (percent === null || percent === 100) return size ? formatSize(size) : null;
  return size ? `${percent}% of ${formatSize(size)}` : `${percent}%`;
}

function waitingTitle(remaining: number): string {
  return `Restarting when ${remaining === 1 ? '1 task finishes' : `${remaining} tasks finish`}`;
}

function checkedAt(state: UpdateSnapshot): string {
  if (!state.lastCheckedAt) return `${APP_NAME} hasn’t checked yet.`;
  const checked = new Date(state.lastCheckedAt).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `Last checked ${checked}.`;
}

export function remainingTasks(state: UpdateSnapshot): number {
  return state.waiting.filter((item) => !item.finished).length;
}

const SKIP: UpdateAction = { id: 'skip', label: 'Skip this version' };

function describe(
  stage: UpdateStage,
  tone: UpdateDescription['tone'],
  title: string,
  body: string,
  extra: Partial<Pick<UpdateDescription, 'note' | 'detail' | 'lines' | 'actions'>> = {}
): UpdateDescription {
  return { stage, tone, title, body, note: null, detail: null, lines: [], actions: [], ...extra };
}

/**
 * The one reading of an update snapshot. Settings and keys come first, because nothing else can
 * happen until they're fixed; then a restart in progress, the finished-update confirmation, and
 * the download from the end back to the offer.
 *
 * `confirmUpdated` lets the update that just installed take its turn. Only the card shows that
 * confirmation; the page lists the same lines under What's new, and the rail describes what's
 * next.
 */
export function describeUpdate(
  state: UpdateSnapshot,
  { confirmUpdated = false }: { confirmUpdated?: boolean } = {}
): UpdateDescription {
  const name = `${APP_NAME} ${state.version}`;
  if (state.blocked === 'not-in-applications') {
    return describe('blocked-folder', 'warn', `${APP_NAME} can’t update from this folder`, 'Move it to Applications to get updates.', {
      actions: [{ id: 'move-to-applications', label: 'Move to Applications', primary: true }],
    });
  }
  if (state.blocked === 'no-key') {
    return describe('needs-key', 'warn', 'Enter your update key', 'This build needs a personal key to get updates.');
  }
  if (state.error === 'key') {
    return describe('key-rejected', 'warn', 'Your update key wasn’t accepted', 'Check it against your download page, or ask for a new one.');
  }
  if (state.blocked === 'no-feed') {
    return describe('no-feed', 'warn', 'This build doesn’t update itself', 'Update checks are off for this build.');
  }
  if (state.restartIn !== null) {
    return describe('last-call', 'brand', `Restarting in ${state.restartIn} seconds`, `Everything has finished. Restarting installs ${name}.`, {
      actions: [
        { id: 'restart-now', label: 'Restart now', primary: true },
        { id: 'cancel-waiting', label: 'Not now' },
      ],
    });
  }
  if (state.waiting.length > 0) {
    return describe('waiting', 'brand', waitingTitle(remainingTasks(state)), 'You get 30 seconds to stop it after the last one.', {
      actions: [
        { id: 'restart-now', label: 'Restart now' },
        { id: 'cancel-waiting', label: 'Cancel restart' },
      ],
    });
  }
  if (confirmUpdated && state.showUpdated && state.updated) {
    return describe('updated', 'ok', `${APP_NAME} is now ${state.updated.version}`, '', {
      lines: state.updated.summary,
      actions: [{ id: 'see-what-changed', label: 'See what changed' }],
    });
  }
  if (state.phase === 'ready') {
    return describe('ready', 'brand', `${name} is ready`, 'It installs when you quit. Restart now to get it sooner.', {
      note: state.stackChanges ? 'The next start takes a few minutes while your tools update.' : null,
      actions: [{ id: 'restart-to-update', label: 'Restart to update', primary: true }],
    });
  }
  if (state.phase === 'downloading') {
    return describe('downloading', 'brand', downloadTitle(state), `Keep working. ${APP_NAME} tells you when it’s ready.`, {
      detail: downloadDetail(state),
    });
  }
  // Skipping a version after a failed download leaves the error behind on an idle phase.
  if (state.phase === 'available' && state.error === 'download') {
    return describe('failed', 'warn', `${name} didn’t download`, `Nothing changed. You’re still on ${state.currentVersion}.`, {
      actions: [{ id: 'download', label: 'Try again', primary: true }, SKIP],
    });
  }
  if (state.phase === 'available') {
    const size = state.size ? formatSize(state.size) : null;
    return describe('available', 'brand', `${name} is available`, size ? `${size} download.` : checkedAt(state), {
      detail: size,
      lines: state.summary,
      actions: [{ id: 'download', label: 'Download', primary: true }, SKIP],
    });
  }
  const check: UpdateAction = { id: 'check', label: 'Check now', disabled: state.checking };
  if (state.error === 'check') {
    return describe(
      'check-failed',
      'warn',
      'Couldn’t check for updates',
      `${APP_NAME} couldn’t reach the update server. Check your connection, then try again.`,
      { actions: [check] }
    );
  }
  return describe('current', 'ok', state.checking ? 'Checking…' : `${APP_NAME} is up to date`, checkedAt(state), {
    actions: [check],
  });
}
