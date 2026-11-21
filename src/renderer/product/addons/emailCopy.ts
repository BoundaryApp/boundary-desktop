import type { EmailProviderId } from '../../../shared/types/addons';
import type { EmailWindowChoice } from '../../../shared/emailAccount';

// The email connect sheet's fixed copy (spec decisions 33 to 36).

/** What the first account's consent step says, one statement per line (decision 33). */
export const EMAIL_CONSENT = [
  'Agents in chats on your own profile can search and read the mail you choose, from an index kept on this Mac. Scheduled jobs and the API profile never get it.',
  'Agents can’t send email. Saving drafts is a separate switch, and it’s off.',
  'Anyone who emails you can put instructions in a message. The agent reads them as text.',
  'Your password is kept in the agent stack’s files on this Mac, readable only by the container that logs in. Boundary doesn’t keep it.',
] as const;

export const EMAIL_CHOOSE_ACCOUNT = 'Choose an account';

export const EMAIL_PROVIDER_LABEL: Record<EmailProviderId, string> = {
  icloud: 'iCloud',
  gmail: 'Gmail',
  fastmail: 'Fastmail',
  yahoo: 'Yahoo',
  other: 'Other',
};

export const EMAIL_PREPARING = 'Getting email ready. The first time takes a few minutes.';

export const EMAIL_PROTON_UNTESTED = 'Proton Bridge through this is untested.';

export const EMAIL_SECURITY_LABEL = { tls: 'TLS', starttls: 'STARTTLS', plain: 'Plain' } as const;

export const EMAIL_WINDOW_LABEL: Record<EmailWindowChoice | 'date', string> = {
  '90d': 'Last 90 days',
  '30d': 'Last 30 days',
  '1y': 'Last year',
  all: 'Everything',
  date: 'A date',
};

export const EMAIL_EVERYTHING_HINT = 'The first pass can take hours on a large mailbox.';

export const EMAIL_ATTACHMENTS_LABEL = 'Include attachment text';

/** Each account row's line while Email is off: the indexer is stopped, so no pass result applies. */
export const EMAIL_OFF_ROW = 'Email is off.';

export const EMAIL_SETTINGS_SET = 'These apply to every account. Change them on the Email page.';

