import type { BitwardenAccount, BitwardenOverview } from '../../../shared/types/addons';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import { useWhenStackReady } from './addonPageActions';

// Bitwarden's connected accounts and the agent's access requests, shared by the detail page,
// the store card, the unlock card and the Services rail dot. Main reads them with
// `vault.sh status --json` and `requests --json`, which carry no API key or master password,
// when the stack becomes ready, when the page opens, after each connect, disconnect, unlock and
// lock, and after a chat turn that asked for a login (spec decisions 27 and 30). Nothing polls.

const overview = createIpcStore<BitwardenOverview | null>({
  initial: null,
  start: (store) => {
    try {
      window.electronAPI.addons.bitwarden.onChanged((next) => store.set(next));
    } catch {
      /* no Bitwarden channel in this window; the overview stays empty */
    }
    void reloadBitwarden();
  },
});

/** The last state main read, without asking the stack again. */
async function reloadBitwarden(): Promise<void> {
  try {
    overview.set(await window.electronAPI.addons.bitwarden.overview());
  } catch {
    /* keep the last overview */
  }
}

/** Reads every account's state and the pending requests from the stack, then shows them. */
export async function refreshBitwarden(): Promise<void> {
  try {
    overview.set(await window.electronAPI.addons.bitwarden.refresh());
  } catch {
    /* keep the last overview */
  }
}

export function useBitwardenOverview(): BitwardenOverview | null {
  return useIpcStore(overview);
}

/** Reads the state each time the stack becomes ready, while this stack has the Bitwarden add-on. */
export function useRefreshBitwardenWhenReady(phase: string, available: boolean): void {
  useWhenStackReady(phase, available, refreshBitwarden);
}

/** The stack's own Vaultwarden account, or a terminal-added `scope: all` one: shown, never changed. */
export function isTerminalOnly(a: BitwardenAccount): boolean {
  return a.mode === 'local' || a.scope === 'all';
}

/** A manual account waiting for its master password: locked, with no error. */
export function needsUnlock(a: BitwardenAccount): boolean {
  return a.unlock === 'manual' && a.state === 'locked' && a.error === null && !isTerminalOnly(a);
}

/** States that need the person: locked manual accounts, and anything not working. */
function accountNeedsYou(a: BitwardenAccount): boolean {
  if (needsUnlock(a)) return true;
  if (a.state === 'error' || a.state === 'refused' || a.state === 'unknown') return true;
  return a.state === 'offline' && a.error !== 'broker_down' && a.error !== 'not_loaded';
}

/** Whether Bitwarden needs the person, for the Services dot, the store card and the Installed list. */
export function bitwardenAttention(o: BitwardenOverview | null): boolean {
  return Boolean(o && (o.requests.length > 0 || o.accounts.some(accountNeedsYou)));
}

export function useBitwardenAttention(): boolean {
  return bitwardenAttention(useBitwardenOverview());
}

/** The row's name: the account's slug, or the refused file's name. */
export function accountName(a: Pick<BitwardenAccount, 'slug' | 'file'>): string {
  return a.slug ?? a.file ?? 'account';
}

/** Where the account lives, for its row. */
export function serverText(a: Pick<BitwardenAccount, 'mode'>): string {
  switch (a.mode) {
    case 'cloud':
      return 'bitwarden.com';
    case 'selfhosted':
      return 'Your own server';
    case 'local':
      return 'This Mac’s Vaultwarden';
    default:
      return '';
  }
}

/** The folder or collection the agent reads. */
export function scopeText(scope: string | null): string {
  if (!scope) return '';
  if (scope === 'all') return 'The whole vault';
  if (scope.startsWith('folder:')) return `Folder ${scope.slice('folder:'.length)}`;
  if (scope.startsWith('collection:')) return `Collection ${scope.slice('collection:'.length)}`;
  return scope;
}

export const UNLOCK_LABEL: Record<'manual' | 'stored', string> = {
  manual: 'Ask me each time',
  stored: 'Keep me unlocked',
};

/** Seconds to wait as words: the number, or a minute when the broker doesn't know. */
const waitText = (retryAfter: number | null | undefined): string =>
  typeof retryAfter === 'number' && retryAfter > 0 ? `${retryAfter} seconds` : 'a minute';

/** The row's pill (decision 27): unlocked, locked, offline, not working or refused. */
export function statePill(a: BitwardenAccount): { label: string; tone: 'ok' | 'warn' | 'muted' | 'danger' } {
  switch (a.state) {
    case 'unlocked':
      return { label: 'Unlocked', tone: 'ok' };
    case 'locked':
      return a.error ? { label: 'Not working', tone: 'danger' } : { label: 'Locked', tone: a.unlock === 'manual' ? 'warn' : 'muted' };
    case 'offline':
      return { label: 'Offline', tone: 'muted' };
    case 'refused':
      return { label: 'Refused', tone: 'danger' };
    case 'error':
    case 'unknown':
      return { label: 'Not working', tone: 'danger' };
  }
}

/** The row's line for its state, or null when there's nothing to say. `broker_down` is said once for the page. */
export function accountMessage(a: BitwardenAccount): string | null {
  if (a.state === 'refused') {
    switch (a.error) {
      case 'missing_client_id':
        return 'Bitwarden stores accounts differently since the assistant’s last update. Connect this account again with its API key.';
      case 'bad_slug':
        return `${a.file ? `The account file ${a.file}` : 'An account file'} has a name the stack can’t use. Remove it at the terminal.`;
      default:
        return `The stack can’t read the account file ${a.file ?? `for ${a.slug ?? 'this account'}`}. Fix or remove it at the terminal.`;
    }
  }
  switch (a.error) {
    case null:
      return needsUnlock(a) ? 'Locked since the assistant last started. Unlock it so the agent can use its logins.' : null;
    case 'broker_down':
      return null;
    case 'not_loaded':
      return 'Connected while Bitwarden was running. It starts with the next restart of the assistant.';
    case 'login_refused':
      return 'Bitwarden didn’t accept this account’s API key. Disconnect it and connect it again with a new key.';
    case 'server_unreachable':
      return 'Couldn’t reach this account’s server.';
    case 'rate_limited':
      return `Bitwarden is limiting sign-ins. It tries again in ${waitText(a.retryAfter)}.`;
    default:
      return `This account isn’t working (${a.error}).`;
  }
}

/** A refused account the connect sheet can mend: connected before the stack moved accounts into the add-on store. */
export function needsConnectAgain(a: BitwardenAccount): boolean {
  return a.state === 'refused' && a.error === 'missing_client_id' && a.slug !== null;
}

/** Why there's no Disconnect on a row, or null when there is one. */
export function disconnectNote(a: BitwardenAccount): string | null {
  if (a.mode === 'local') return 'The stack’s own account. Manage it at the terminal.';
  if (a.scope === 'all') return 'Added at the terminal with the whole vault. Remove it at the terminal.';
  if (a.state === 'refused' || a.canDisconnect) return null;
  return 'Added at the terminal. Disconnect works after the next make up records it, or remove it at the terminal.';
}

/** The server's host for a message. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * What the connect sheet says for each `connect` error (spec, phase 8). An error this build
 * doesn't know reads as a bug and names itself.
 */
export function connectErrorText(error: string, slug: string, host: string, retryAfter?: number | null): string {
  switch (error) {
    case 'bad_slug':
      return 'Start the name with a letter, and use up to 31 lowercase letters, numbers and dashes.';
    case 'exists':
      return `An account named ${slug} is already connected. Choose another name, or replace it.`;
    case 'login_refused':
      return 'Bitwarden didn’t accept that API key or master password.';
    case 'rate_limited':
      return `Bitwarden is limiting sign-ins. Try again in ${waitText(retryAfter)}.`;
    case 'server_unreachable':
      return `Couldn’t reach ${host}. Check the address and that the server is running.`;
    case 'timeout':
      return 'Bitwarden didn’t finish signing in. Try again.';
    case 'broker_down':
      return 'Bitwarden isn’t running. Turn it on again, or restart the assistant.';
    default:
      return `Couldn’t connect the account (${error}).`;
  }
}

/** What the unlock sheet says for each `unlock` error (CR 0028 R3). */
export function unlockErrorText(error: string): string {
  switch (error) {
    case 'login_refused':
      return 'That master password didn’t unlock the account. It’s still locked.';
    case 'broker_down':
      return 'Bitwarden isn’t running. Turn it on again, or restart the assistant.';
    case 'not_found':
      return 'Bitwarden hasn’t loaded this account yet. It starts with the next restart of the assistant.';
    default:
      return `Couldn’t unlock the account (${error}).`;
  }
}
