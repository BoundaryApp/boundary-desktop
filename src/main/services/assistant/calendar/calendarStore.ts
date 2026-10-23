import { safeStorage } from 'electron';
import Store from 'electron-store';
import type {
  CalendarAccess,
  CalendarAccountView,
  CalendarCheck,
  CalendarInfo,
  CalendarProvider,
} from '../../../../shared/types/calendars';

/**
 * Connected calendars. The password is encrypted with the OS keychain; Boundary keeps it so it
 * can give a newly granted agent access or rewrite a profile's `.env` without asking again.
 * Hermes holds its own copy in each granted profile's `.env`.
 */

export interface StoredCalendarAccount {
  slug: string;
  name: string;
  provider: CalendarProvider;
  url: string;
  username: string;
  /** base64 of `safeStorage.encryptString(password)`. */
  password: string;
  calendars: CalendarInfo[];
  access: Record<string, CalendarAccess>;
  createdAt: string;
  lastCheck: CalendarCheck | null;
}

interface CalendarStoreState {
  accounts: StoredCalendarAccount[];
}

let store: Store<CalendarStoreState> | null = null;
function getStore(): Store<CalendarStoreState> {
  store ??= new Store<CalendarStoreState>({ name: 'calendars', defaults: { accounts: [] } });
  return store;
}

export function canStoreCalendarPasswords(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function encryptCalendarPassword(password: string): string {
  return safeStorage.encryptString(password).toString('base64');
}

/** The password, or null when the keychain can't decrypt it (reset, another Mac). */
export function decryptCalendarPassword(account: StoredCalendarAccount): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(account.password, 'base64'));
  } catch {
    return null;
  }
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

export function toCalendarAccountView(account: StoredCalendarAccount): CalendarAccountView {
  const password = decryptCalendarPassword(account);
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
  };
}
