import { missingSettingsMessage } from '../../../shared/emailAccount';
import type { ActualScriptFailure, EmailAccount, EmailOverview } from '../../../shared/types/addons';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import { useWhenStackReady } from './addonPageActions';

// Email's accounts and each account's state from the indexer's last pass, shared by the detail
// page, the store card and the Services rail dot. Main reads `addon.sh list --json` and the
// indexer's log, which carry no password, and broadcasts every change (spec decision 37). The
// page polls while a pass is owed; this store itself does not.

const overview = createIpcStore<EmailOverview | null>({
  initial: null,
  start: (store) => {
    try {
      window.electronAPI.addons.email.onChanged((next) => store.set(next));
    } catch {
      /* no email channel in this window; the overview stays empty */
    }
    void reloadEmail();
  },
});

/** The last state main read, without asking the stack again. */
async function reloadEmail(): Promise<void> {
  try {
    overview.set(await window.electronAPI.addons.email.overview());
  } catch {
    /* keep the last overview */
  }
}

/** Reads the accounts and the indexer's log from the stack, then shows them. */
export async function refreshEmail(): Promise<void> {
  try {
    overview.set(await window.electronAPI.addons.email.refresh());
  } catch {
    /* keep the last overview */
  }
}

export function useEmailOverview(): EmailOverview | null {
  return useIpcStore(overview);
}

/** Reads the state each time the stack becomes ready, while this stack has the email add-on. */
export function useRefreshEmailWhenReady(phase: string, available: boolean): void {
  useWhenStackReady(phase, available, refreshEmail);
}

/** Whether any account's login was refused, for the Services dot, the store card and the Installed list. */
export function emailAttention(o: EmailOverview | null): boolean {
  return Boolean(o?.accounts.some((a) => a.state === 'login_refused'));
}

export function useEmailAttention(): boolean {
  return emailAttention(useEmailOverview());
}

/** `HH:MM` in the person's time zone, or an empty string for a time that doesn't parse. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The row's line for the account's state (decision 37). */
export function rowMessage(a: Pick<EmailAccount, 'state' | 'host' | 'detail' | 'indexedAt'>): string | null {
  switch (a.state) {
    case 'waiting':
      return 'Waiting for the first pass';
    case 'indexed': {
      const at = a.indexedAt ? clockTime(a.indexedAt) : '';
      return at ? `Indexed at ${at}` : 'Indexed';
    }
    case 'login_refused':
      return 'The server didn’t accept the password.';
    case 'unreachable':
      return `Couldn’t reach ${a.host}.`;
    case 'left_out':
      return a.detail ? `Left out: ${a.detail}` : 'Left out';
  }
}

/**
 * What the connect sheet says for each failure (spec, phase 9). `listMailboxes` errors name the
 * host; a configure error that isn't `busy` names the stack's line, since it means a bug.
 */
export function listingErrorText(f: ActualScriptFailure, host: string): string {
  switch (f.error) {
    case 'login_refused':
      return 'The server didn’t accept that address and app password.';
    case 'server_unreachable':
      return `Couldn’t reach ${host}. Check the server and port.`;
    case 'listing_failed':
      return `Couldn’t list the mailboxes: ${f.message}`;
    case 'busy':
      return 'Another add-on change is running. Try again in a moment.';
    case 'missing_settings':
      return missingSettingsMessage(f.message);
    default:
      return `Couldn’t save the account (${f.message}).`;
  }
}
