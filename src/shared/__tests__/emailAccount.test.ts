import { describe, expect, it } from 'vitest';
import {
  EMAIL_PROVIDERS,
  EVERYTHING_SINCE,
  OTHER_DEFAULT_SLUG,
  defaultMailboxes,
  isEmailSlug,
  plainAllowed,
  sinceFor,
  windowChoiceOf,
} from '../emailAccount';
import type {
  EmailAccountInput,
  EmailMailboxesResult,
  EmailOverview,
  EmailSettingsInput,
} from '../types/addons';

const today = new Date(2026, 10, 11);

describe('isEmailSlug', () => {
  it('accepts a letter followed by up to 30 of a-z, 0-9 and -', () => {
    expect(isEmailSlug('icloud')).toBe(true);
    expect(isEmailSlug('a')).toBe(true);
    expect(isEmailSlug('a' + 'b'.repeat(30))).toBe(true);
    expect(isEmailSlug('work-2')).toBe(true);
  });
  it('rejects the rest', () => {
    expect(isEmailSlug('1mail')).toBe(false);
    expect(isEmailSlug('Mail')).toBe(false);
    expect(isEmailSlug('a' + 'b'.repeat(31))).toBe(false);
    expect(isEmailSlug('')).toBe(false);
    expect(isEmailSlug(5)).toBe(false);
  });
});

describe('plainAllowed', () => {
  it('allows only local hosts', () => {
    expect(plainAllowed('host.docker.internal')).toBe(true);
    expect(plainAllowed('localhost')).toBe(true);
    expect(plainAllowed('127.0.0.1')).toBe(true);
    expect(plainAllowed('imap.example.com')).toBe(false);
    expect(plainAllowed('greenmail')).toBe(false);
  });
});

describe('sinceFor and windowChoiceOf', () => {
  it('computes local dates', () => {
    expect(sinceFor('90d', today)).toBe('2026-08-13');
    expect(sinceFor('30d', today)).toBe('2026-10-12');
    expect(sinceFor('1y', today)).toBe('2025-11-11');
    expect(sinceFor('all', today)).toBe(EVERYTHING_SINCE);
    expect(EVERYTHING_SINCE).toBe('1970-01-01');
  });
  it('names a window only on an exact match', () => {
    expect(windowChoiceOf('1970-01-01', today)).toBe('all');
    expect(windowChoiceOf('2026-08-13', today)).toBe('90d');
    expect(windowChoiceOf('2026-10-12', today)).toBe('30d');
    expect(windowChoiceOf('2025-11-11', today)).toBe('1y');
    expect(windowChoiceOf('2026-01-02', today)).toBe('date');
  });
});

describe('defaultMailboxes', () => {
  it('picks INBOX and the Sent mailbox', () => {
    expect(
      defaultMailboxes([
        { name: 'INBOX', messages: 3, specialUse: [] },
        { name: 'Sent Messages', messages: 1, specialUse: ['\\sent'] },
        { name: 'Junk', messages: 0, specialUse: ['\\junk'] },
      ]),
    ).toEqual(['INBOX', 'Sent Messages']);
  });
  it('preselects the stack’s lowercase \\sent, and a server’s \\Sent too', () => {
    expect(defaultMailboxes([{ name: 'Gesendet', messages: 4, specialUse: ['\\sent'] }])).toEqual(['Gesendet']);
    expect(defaultMailboxes([{ name: 'Sent', messages: 4, specialUse: ['\\Sent'] }])).toEqual(['Sent']);
  });
  it('matches INBOX in any case', () => {
    expect(defaultMailboxes([{ name: 'Inbox', messages: null, specialUse: [] }])).toEqual(['Inbox']);
  });
});

describe('EMAIL_PROVIDERS', () => {
  it('has the stack hosts and slugs', () => {
    expect(EMAIL_PROVIDERS.icloud.host).toBe('imap.mail.me.com');
    expect(EMAIL_PROVIDERS.gmail.host).toBe('imap.gmail.com');
    expect(EMAIL_PROVIDERS.fastmail.host).toBe('imap.fastmail.com');
    expect(EMAIL_PROVIDERS.yahoo.host).toBe('imap.mail.yahoo.com');
    for (const [id, p] of Object.entries(EMAIL_PROVIDERS)) {
      expect(p.slug).toBe(id);
      expect(isEmailSlug(p.slug)).toBe(true);
      expect(p.port).toBe(993);
      expect(p.security).toBe('tls');
      expect(p.helpUrl).toMatch(/^https:\/\//);
      expect(p.steps.length).toBeGreaterThan(0);
    }
  });
});

describe('email types', () => {
  it('describe an account for a preset, with a null password keeping the stored one', () => {
    const p = EMAIL_PROVIDERS.fastmail;
    const input: EmailAccountInput = {
      slug: p.slug,
      host: p.host,
      port: p.port,
      security: p.security,
      user: 'ada@example.com',
      address: 'ada@example.com',
      password: null,
    };
    expect(isEmailSlug(input.slug)).toBe(true);
    expect(input.password).toBeNull();
  });

  it('give Other the default slug mail', () => {
    expect(OTHER_DEFAULT_SLUG).toBe('mail');
    expect(isEmailSlug(OTHER_DEFAULT_SLUG)).toBe(true);
  });

  it('carry settings, a mailbox list and an empty overview', () => {
    const settings: EmailSettingsInput = { since: sinceFor('90d', today), attachments: false, drafts: false };
    const listed: EmailMailboxesResult = {
      ok: true,
      mailboxes: [{ name: 'INBOX', messages: 2, specialUse: [] }],
    };
    const overview: EmailOverview = {
      available: true,
      enabled: false,
      drafts: settings.drafts,
      since: settings.since,
      attachments: settings.attachments,
      accounts: [],
      lastPass: null,
      passOwed: false,
      readError: null,
    };
    expect(listed.ok && defaultMailboxes(listed.mailboxes)).toEqual(['INBOX']);
    expect(overview.accounts).toEqual([]);
  });
});
