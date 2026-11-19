import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailAccount, EmailOverview } from '../../../../shared/types/addons';
import { AddonDetail } from '../AddonDetail';
import { AddonStore, type StorePage } from '../AddonStore';
import { EMAIL_CONSENT } from '../emailCopy';
import { emailListing, stubAddons } from './addonFixtures';

// Email's page against a fake main (spec decisions 37 and 38): account rows with their state,
// the settings card, re-reading while a pass is owed, Remove, and Remove and delete data.

vi.mock('../../assistantStack', () => ({
  useAssistantStackLifecycle: () => ({ phase: 'ready' }),
  useAssistantStackStatus: () => ({ ready: true, uiServices: [] as never[], ports: {} }),
  refreshAssistantStackStatus: async () => {},
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const account = (extra: Partial<EmailAccount> = {}): EmailAccount => ({
  slug: 'work',
  host: 'imap.example.com',
  port: 993,
  security: 'tls',
  user: 'pat@example.com',
  address: 'pat@example.com',
  mailboxes: ['INBOX', 'Sent'],
  passwordSet: true,
  state: 'indexed',
  detail: null,
  indexedAt: null,
  ...extra,
});

const overviewWith = (extra: Partial<EmailOverview> = {}): EmailOverview => ({
  available: true,
  enabled: true,
  drafts: false,
  since: '1970-01-01',
  attachments: false,
  accounts: [account()],
  lastPass: null,
  passOwed: false,
  readError: null,
  ...extra,
});

function renderPage() {
  render(<AddonDetail id="email" onBack={() => undefined} onInstallStarted={() => undefined} />);
}

const row = (slug: string) => screen.findByRole('listitem', { name: slug });

describe('EmailDetail', () => {
  it('rows show Waiting, Indexed, refused and unreachable states', async () => {
    const at = new Date(2026, 10, 11, 9, 5).toISOString();
    stubAddons([emailListing(true)], {
      email: overviewWith({
        accounts: [
          account({ slug: 'home', address: 'sam@example.com', state: 'waiting', mailboxes: ['INBOX'] }),
          account({ slug: 'work', state: 'indexed', indexedAt: at, mailboxes: ['INBOX', 'Sent', 'Projects'] }),
          account({ slug: 'old', host: 'mail.example.net', state: 'login_refused' }),
          account({ slug: 'club', host: 'imap.example.org', state: 'unreachable' }),
        ],
        lastPass: { at, inScope: 1204 },
      }),
    });
    renderPage();

    const home = await row('home');
    expect(within(home).getByText('Waiting for the first pass')).toBeTruthy();
    expect(within(home).getByText('sam@example.com · imap.example.com · Inbox')).toBeTruthy();

    const work = await row('work');
    expect(within(work).getByText('Indexed at 09:05')).toBeTruthy();
    expect(within(work).getByText('pat@example.com · imap.example.com · 3 mailboxes')).toBeTruthy();

    const old = await row('old');
    expect(within(old).getByText('The server didn’t accept the password.')).toBeTruthy();
    expect(within(old).getByText('pat@example.com · mail.example.net · Inbox, Sent')).toBeTruthy();
    // Change password is on every row, and primary where the login was refused.
    expect(within(old).getByRole('button', { name: 'Change password' }).className).toContain('wb-btn-solid');
    expect(within(work).getByRole('button', { name: 'Change password' }).className).not.toContain('wb-btn-solid');

    expect(within(await row('club')).getByText('Couldn’t reach imap.example.org.')).toBeTruthy();
    expect(screen.getByText(`${(1204).toLocaleString()} messages in the index; last pass 09:05`)).toBeTruthy();
  });

  it('re-reads every 30 seconds while a pass is owed and stops once it isn’t', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const owed = overviewWith({ passOwed: true, accounts: [account({ state: 'waiting' })] });
    const addons = stubAddons([emailListing(true)], { email: owed });
    renderPage();
    await row('work');
    // Once when the page opens.
    await vi.waitFor(() => expect(addons.email.refresh).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(addons.email.refresh).toHaveBeenCalledTimes(2);

    addons.email.refresh.mockResolvedValue(overviewWith({ passOwed: false }));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(addons.email.refresh).toHaveBeenCalledTimes(3);
    await within(await row('work')).findByText('Indexed');

    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(addons.email.refresh).toHaveBeenCalledTimes(3);
  });

  it('turning drafts on calls email-settings with drafts true', async () => {
    const addons = stubAddons([emailListing(true)], { email: overviewWith({ since: '1970-01-01', attachments: true }) });
    renderPage();
    const drafts = (await screen.findByRole('checkbox', { name: 'Let agents save drafts (never sends)' })) as HTMLInputElement;
    expect(drafts.checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Include attachment text' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('How far back') as HTMLSelectElement).value).toBe('all');
    fireEvent.click(drafts);
    await vi.waitFor(() => expect(addons.email.setSettings).toHaveBeenCalledTimes(1));
    expect(addons.email.setSettings).toHaveBeenCalledWith({ since: '1970-01-01', attachments: true, drafts: true });
    expect(await screen.findByText('New chats get the change.')).toBeTruthy();
  });

  it('while Email is off, every row says so, the totals are hidden and drafts can’t be switched', async () => {
    const at = new Date(2026, 10, 11, 9, 5).toISOString();
    stubAddons([emailListing(false)], {
      email: overviewWith({
        enabled: false,
        accounts: [account({ slug: 'home', state: 'waiting' }), account({ slug: 'work', state: 'indexed', indexedAt: at })],
        lastPass: { at, inScope: 1204 },
      }),
    });
    renderPage();
    expect(within(await row('home')).getByText('Email is off.')).toBeTruthy();
    expect(within(await row('work')).getByText('Email is off.')).toBeTruthy();
    expect(screen.queryByText(/messages in the index/)).toBeNull();
    const drafts = screen.getByRole('checkbox', { name: 'Let agents save drafts (never sends)' }) as HTMLInputElement;
    expect(drafts.disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Include attachment text' }) as HTMLInputElement).disabled).toBe(false);
  });

  it('a drafts change that needs a setting names it, not the stack’s key', async () => {
    const addons = stubAddons([emailListing(true)], { email: overviewWith() });
    addons.email.setSettings.mockResolvedValueOnce({
      success: true,
      result: { ok: false, error: 'missing_settings', message: 'missing settings: work.password' },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Let agents save drafts (never sends)' }));
    expect(await screen.findByText('Couldn’t turn on email: password for work.')).toBeTruthy();
    expect(screen.queryByText(/work\.password/)).toBeNull();
  });

  it('a failed command shows the stack’s message', async () => {
    const addons = stubAddons([emailListing(true)], { email: overviewWith() });
    addons.email.setSettings.mockResolvedValueOnce({
      success: true,
      result: { ok: false, error: 'command_failed', message: 'settings.env is read-only' },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Include attachment text' }));
    expect(await screen.findByText('Couldn’t change the settings: settings.env is read-only')).toBeTruthy();
  });

  it('Remove asks first, then removes the account', async () => {
    const addons = stubAddons([emailListing(true)], { email: overviewWith() });
    renderPage();
    fireEvent.click(within(await row('work')).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove work?' });
    expect(addons.email.removeAccount).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await vi.waitFor(() => expect(addons.email.removeAccount).toHaveBeenCalledWith('work'));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Remove and delete data needs the typed confirmation', async () => {
    const addons = stubAddons([emailListing(true)], { email: overviewWith() });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove and delete data' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'This deletes the index, the drafts queue and the stored passwords. Nothing changes on your mail servers.'
      )
    ).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Remove and delete data' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type delete to confirm'), { target: { value: 'delete' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(addons.remove).toHaveBeenCalledWith('email', { deleteImages: false });
  });
});

const Store: React.FC = () => {
  const [page, setPage] = useState<StorePage>({ view: 'category', category: 'work' });
  return <AddonStore page={page} go={setPage} onServices={() => undefined} />;
};

describe('Email in the store', () => {
  it('Get on the store opens the consent step', async () => {
    const addons = stubAddons([emailListing(false)], { email: overviewWith({ enabled: false, accounts: [], since: null }) });
    render(<Store />);
    const card = await screen.findByRole('button', { name: 'Email' });
    fireEvent.click(within(card).getByRole('button', { name: 'Get Email' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(EMAIL_CONSENT[0])).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Choose an account' })).toBeTruthy();
    expect(addons.install).not.toHaveBeenCalled();
  });
});
