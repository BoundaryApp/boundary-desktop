// The checks the stack's IMAP add-on makes, so the connect sheet never sends what the stack
// would refuse. Provider hosts and steps are the ones each provider documents for app passwords.

import type { EmailMailbox, EmailProviderId } from './types/addons';
import { localDay } from './utils/localDay';
import { ADDON_SLUG } from './utils/slug';

export interface EmailProviderPreset {
  name: string;
  host: string;
  port: 993;
  security: 'tls';
  slug: string;
  helpUrl: string;
  steps: string[];
}

export const EMAIL_PROVIDERS: Record<Exclude<EmailProviderId, 'other'>, EmailProviderPreset> = {
  icloud: {
    name: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    security: 'tls',
    slug: 'icloud',
    helpUrl: 'https://support.apple.com/102654',
    steps: [
      'Open account.apple.com and sign in with your Apple Account.',
      'Go to Sign-In and Security, then App-Specific Passwords.',
      'Choose Generate an app-specific password and name it for this app.',
      'Enter your Apple Account password if Apple asks, then copy the new password.',
    ],
  },
  gmail: {
    name: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    security: 'tls',
    slug: 'gmail',
    helpUrl: 'https://support.google.com/accounts/answer/185833',
    steps: [
      'Turn on 2-Step Verification for your Google Account.',
      'Open myaccount.google.com/apppasswords and sign in.',
      'Create an app password, then copy it.',
    ],
  },
  fastmail: {
    name: 'Fastmail',
    host: 'imap.fastmail.com',
    port: 993,
    security: 'tls',
    slug: 'fastmail',
    helpUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords',
    steps: [
      'In Fastmail, open Settings, then Privacy & Security.',
      'Open the app passwords page and start a new app password.',
      'Name it for this app and keep the access set to Mail, Contacts & Calendars.',
      'Generate the password and copy it.',
    ],
  },
  yahoo: {
    name: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    security: 'tls',
    slug: 'yahoo',
    helpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    steps: [
      'Open your Yahoo Account Security page and sign in.',
      'Under External connections, create an app password.',
      'Name it for this app and generate the password.',
      'Copy the password, then select Done.',
    ],
  },
};

/** The default account name for Other. */
export const OTHER_DEFAULT_SLUG = 'mail';

/** The stack's account-name rule, ADDON_SLUG. */
export function isEmailSlug(value: unknown): value is string {
  return typeof value === 'string' && ADDON_SLUG.test(value);
}

/** Hosts where the stack accepts an unencrypted connection (its list minus its own test host). */
const PLAIN_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];

export function plainAllowed(host: string): boolean {
  return PLAIN_HOSTS.includes(host);
}

/** The `since` value that means no date limit. */
export const EVERYTHING_SINCE = '1970-01-01';

export type EmailWindowChoice = '90d' | '30d' | '1y' | 'all';

/** The local `YYYY-MM-DD` a window starts on, counted back from `today`. */
export function sinceFor(choice: EmailWindowChoice, today: Date): string {
  if (choice === 'all') return EVERYTHING_SINCE;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (choice === '1y') start.setFullYear(start.getFullYear() - 1);
  else start.setDate(start.getDate() - (choice === '90d' ? 90 : 30));
  return localDay(start);
}

/** The window a stored `since` equals exactly; any other date is `'date'`. */
export function windowChoiceOf(since: string, today: Date): EmailWindowChoice | 'date' {
  for (const choice of ['90d', '30d', '1y', 'all'] as const) {
    if (sinceFor(choice, today) === since) return choice;
  }
  return 'date';
}

/**
 * INBOX (any case) and every mailbox marked Sent. The stack lowercases LIST flags (`\sent`),
 * so the flag is compared in any case too.
 */
export function defaultMailboxes(list: EmailMailbox[]): string[] {
  return list
    .filter((m) => m.name.toUpperCase() === 'INBOX' || m.specialUse.some((u) => u.toLowerCase() === '\\sent'))
    .map((m) => m.name);
}

/** Names one item of the stack's `missing settings: ...` message (from `enable`) for the person. */
function missingName(item: string): string {
  if (item === 'instances:accounts') return 'an account';
  if (item === 'since') return 'the mail window';
  const dot = item.indexOf('.');
  if (dot > 0 && dot < item.length - 1) return `${item.slice(dot + 1)} for ${item.slice(0, dot)}`;
  return item;
}

/** `Couldn’t turn on email: ...` from the stack's `missing settings: a, b` message. */
export function missingSettingsMessage(message: string): string {
  const names = message
    .replace(/^missing settings:\s*/, '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map(missingName);
  return `Couldn’t turn on email: ${names.join(', ') || 'a required setting'}.`;
}
