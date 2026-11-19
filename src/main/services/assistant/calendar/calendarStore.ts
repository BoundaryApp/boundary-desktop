import Store from 'electron-store';
import type {
  CalendarAccess,
  CalendarAccountView,
  CalendarCheck,
  CalendarInfo,
  CalendarProvider,
} from '../../../../shared/types/calendars';
import { tryDecryptFromBase64 } from '../../secrets/osEncryption';

/**
 * Connected calendars. The password is encrypted with the OS keychain; Boundary keeps it so it
 * can give a newly granted agent access or rewrite a profile's `.env` without asking again.
 * Hermes holds its own copy in each granted profile's `.env`.
 *
 * The Mac account (provider `mac`) has no address or password: `url`, `username` and `password`
 * are `''`. Each granted agent has its own bridge token instead, in `agentTokens`.
 */

export interface StoredCalendarAccount {
  slug: string;
  name: string;
  provider: CalendarProvider;
  url: string;
  username: string;
  /** base64 of the keychain-encrypted password. */
  password: string;
  calendars: CalendarInfo[];
  access: Record<string, CalendarAccess>;
  createdAt: string;
  lastCheck: CalendarCheck | null;
  /** Missing on accounts saved before Phase 2; see `lastWorkedAt`. */
  lastOkAt?: string;
  /** The Mac account only: the calendars agents may see. Missing means none. */
  allowedCalendarIds?: string[];
  /**
   * The Mac account only: the allowed calendars' titles when last listed, by id, so one that
   * disappears from the Mac can be named on the card.
   */
  allowedCalendarTitles?: Record<string, string>;
  /** The Mac account only: agent slug → base64 of its keychain-encrypted `/calendar` token. */
  agentTokens?: Record<string, string>;
}

interface CalendarStoreState {
  accounts: StoredCalendarAccount[];
}

let store: Store<CalendarStoreState> | null = null;
function getStore(): Store<CalendarStoreState> {
  store ??= new Store<CalendarStoreState>({ name: 'calendars', defaults: { accounts: [] } });
  return store;
}

/** The password, or null when the keychain can't decrypt it (reset, another Mac). */
export function decryptCalendarPassword(account: StoredCalendarAccount): Promise<string | null> {
  return tryDecryptFromBase64(account.password, (reEncrypted) => {
    const accounts = listCalendarAccounts();
    if (!accounts.some((a) => a.password === account.password)) return;
    getStore().set(
      'accounts',
      accounts.map((a) => (a.password === account.password ? { ...a, password: reEncrypted } : a))
    );
  });
}

export function listCalendarAccounts(): StoredCalendarAccount[] {
  return getStore().get('accounts');
}

export function hasCalendarAccounts(): boolean {
  return listCalendarAccounts().length > 0;
}

export function getCalendarAccount(slug: string): StoredCalendarAccount | null {
  return listCalendarAccounts().find((a) => a.slug === slug) ?? null;
}

export function saveCalendarAccount(account: StoredCalendarAccount): void {
  const others = listCalendarAccounts().filter((a) => a.slug !== account.slug);
  getStore().set('accounts', [...others, account]);
}

export function deleteCalendarAccount(slug: string): void {
  getStore().set(
    'accounts',
    listCalendarAccounts().filter((a) => a.slug !== slug)
  );
}

/** When the sign-in last worked, for accounts saved before `lastOkAt` was recorded too. */
export function lastWorkedAt(account: StoredCalendarAccount): string | null {
  if (account.lastOkAt) return account.lastOkAt;
  if (account.lastCheck?.status === 'ok') return account.lastCheck.at;
  // Connect only saves after the sign-in test passes.
  return account.createdAt || null;
}

/** Whether a CalDAV account is connected: those need the stack's caldav-mcp, the Mac account doesn't. */
export function hasCalDavAccounts(): boolean {
  return listCalendarAccounts().some((a) => a.provider !== 'mac');
}

/** The Mac account, if one is connected. There is at most one. */
export function getMacCalendarAccount(): StoredCalendarAccount | null {
  return listCalendarAccounts().find((a) => a.provider === 'mac') ?? null;
}

export async function toCalendarAccountView(account: StoredCalendarAccount): Promise<CalendarAccountView> {
  const password = account.provider === 'mac' ? null : await decryptCalendarPassword(account);
  return {
    slug: account.slug,
    name: account.name,
    provider: account.provider,
    url: account.url,
    username: account.username,
    passwordTail: password ? password.slice(-4) : '',
    calendars: account.calendars,
    access: account.access,
    createdAt: account.createdAt,
    lastCheck: account.lastCheck,
    lastOkAt: lastWorkedAt(account),
    ...(account.provider === 'mac' ? { allowedCalendarIds: account.allowedCalendarIds ?? [] } : {}),
  };
}
