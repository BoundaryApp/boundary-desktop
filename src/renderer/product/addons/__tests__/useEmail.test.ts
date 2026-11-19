import { describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { EmailAccount, EmailOverview } from '../../../../shared/types/addons';
import { addonStoreItem } from '../storeItems';
import { emailAttention, listingErrorText, refreshEmail, rowMessage, useEmailOverview } from '../useEmail';
import { renderHook, waitFor } from '@testing-library/react';
import { emailListing } from './addonFixtures';
import { searchStore } from '../storeSearch';

const account = (extra: Partial<EmailAccount> = {}): EmailAccount => ({
  slug: 'mail',
  host: 'imap.example.com',
  port: 993,
  security: 'tls',
  user: 'pat@example.com',
  address: 'pat@example.com',
  mailboxes: ['INBOX'],
  passwordSet: true,
  state: 'waiting',
  detail: null,
  indexedAt: null,
  ...extra,
});
const overview = (accounts: EmailAccount[], extra: Partial<EmailOverview> = {}): EmailOverview => ({
  available: true,
  enabled: true,
  drafts: false,
  since: null,
  attachments: false,
  accounts,
  lastPass: null,
  passOwed: false,
  readError: null,
  ...extra,
});

describe('rowMessage', () => {
  it('says what each state shows', () => {
    expect(rowMessage(account({ state: 'waiting' }))).toBe('Waiting for the first pass');
    const at = new Date(2026, 10, 11, 9, 5).toISOString();
    expect(rowMessage(account({ state: 'indexed', indexedAt: at }))).toBe('Indexed at 09:05');
    expect(rowMessage(account({ state: 'indexed' }))).toBe('Indexed');
    expect(rowMessage(account({ state: 'login_refused' }))).toBe('The server didn’t accept the password.');
    expect(rowMessage(account({ state: 'unreachable' }))).toBe('Couldn’t reach imap.example.com.');
    expect(rowMessage(account({ state: 'left_out', detail: 'no mailboxes chosen' }))).toBe('Left out: no mailboxes chosen');
  });
});

describe('listingErrorText', () => {
  const fail = (error: string, message = '') => ({ ok: false as const, error, message });
  it('follows the phase 9 table', () => {
    expect(listingErrorText(fail('login_refused'), 'imap.example.com')).toBe('The server didn’t accept that address and app password.');
    expect(listingErrorText(fail('server_unreachable'), 'imap.example.com')).toBe('Couldn’t reach imap.example.com. Check the server and port.');
    expect(listingErrorText(fail('listing_failed', 'addon.sh run exited with code 4'), 'h')).toBe(
      'Couldn’t list the mailboxes: addon.sh run exited with code 4'
    );
    expect(listingErrorText(fail('bad_input', 'bad host'), 'h')).toBe('Couldn’t save the account (bad host).');
    expect(listingErrorText(fail('command_failed', 'boom'), 'h')).toBe('Couldn’t save the account (boom).');
    expect(listingErrorText(fail('busy', 'x'), 'h')).toBe('Another add-on change is running. Try again in a moment.');
    expect(listingErrorText(fail('missing_settings', 'missing settings: instances:accounts'), 'h')).toBe('Couldn’t turn on email: an account.');
  });
});

describe('emailAttention', () => {
  it('is true only for a refused login', () => {
    expect(emailAttention(null)).toBe(false);
    expect(emailAttention(overview([account({ state: 'unreachable' })]))).toBe(false);
    expect(emailAttention(overview([account(), account({ slug: 'b', state: 'login_refused' })]))).toBe(true);
  });
});

describe('Email’s store card', () => {
  it('lists Email with Get when the stack offers it, and searching inbox finds it', () => {
    const item = addonStoreItem(emailListing(), null, null, null, null, overview([], { enabled: false }));
    expect(item).toMatchObject({ key: 'email', category: 'work', staysLocal: true, state: { kind: 'get' }, attention: false });
    expect(item.tryAsking).toBe('What did Pat say about the venue?');
    expect(searchStore([item], 'inbox').map((i) => i.key)).toEqual(['email']);
  });

  it('reports data left behind when accounts exist while it is off, and flags a refused login', () => {
    const off = overview([account({ state: 'login_refused' })], { enabled: false });
    const item = addonStoreItem(emailListing(), null, null, null, null, off);
    expect(item.state).toEqual({ kind: 'off-data' });
    expect(item.attention).toBe(true);
  });
});

describe('refreshEmail', () => {
  it('shows what main read, and keeps the last overview when the read fails', async () => {
    const next = overview([account({ state: 'login_refused' })]);
    const refresh = vi.fn().mockResolvedValueOnce(next).mockRejectedValueOnce(new Error('down'));
    stubElectronAPI({
      addons: { email: { overview: vi.fn(async () => null), refresh, onChanged: vi.fn(() => () => {}) } },
    });
    const { result } = renderHook(() => useEmailOverview());
    await refreshEmail();
    await waitFor(() => expect(result.current).toEqual(next));
    await refreshEmail();
    expect(result.current).toEqual(next);
  });
});
