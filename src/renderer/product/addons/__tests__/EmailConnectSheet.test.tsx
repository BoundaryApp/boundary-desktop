import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EmailAccount, EmailMailbox, EmailOverview } from '../../../../shared/types/addons';
import { EmailConnectSheet } from '../EmailConnectSheet';
import { EMAIL_CONSENT } from '../emailCopy';
import { refreshEmail } from '../useEmail';
import { emailListing, stubAddons } from './addonFixtures';

const LIST: EmailMailbox[] = [
  { name: 'INBOX', messages: 1204, specialUse: [] },
  { name: 'Sent Messages', messages: 310, specialUse: ['\\sent'] },
  { name: 'Junk', messages: 12, specialUse: ['\\junk'] },
  { name: 'Projects/Alpha', messages: 48, specialUse: [] },
];

const refused = { success: true, result: { ok: false, error: 'login_refused', message: 'the server rejected the user name or password' } };
const listed = { success: true, result: { ok: true, mailboxes: LIST } };
const busyReply = { success: true, result: { ok: false, error: 'busy', message: 'another add-on change is running' } };
const BUSY_TEXT = 'Another add-on change is running. Try again in a moment.';

const account = (extra: Partial<EmailAccount> = {}): EmailAccount => ({
  slug: 'work',
  host: 'imap.example.com',
  port: 143,
  security: 'starttls',
  user: 'pat',
  address: 'pat@example.com',
  mailboxes: ['INBOX', 'Projects/Alpha'],
  passwordSet: true,
  state: 'login_refused',
  detail: null,
  indexedAt: null,
  ...extra,
});

const overview = (extra: Partial<EmailOverview> = {}): EmailOverview => ({
  available: true,
  enabled: false,
  drafts: false,
  since: null,
  attachments: false,
  accounts: [],
  lastPass: null,
  passOwed: false,
  readError: null,
  ...extra,
});

type Mode = React.ComponentProps<typeof EmailConnectSheet>['mode'];

function open(mode: Mode, email?: EmailOverview, setup?: (addons: ReturnType<typeof stubAddons>) => void) {
  const addons = stubAddons([emailListing()], { email });
  setup?.(addons);
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const { rerender } = render(<EmailConnectSheet mode={mode} onClose={onClose} onStarted={onStarted} />);
  const dialog = screen.getByRole('dialog');
  const button = (name: string | RegExp) => within(dialog).getByRole('button', { name }) as HTMLButtonElement;
  const field = (name: string | RegExp) => within(dialog).getByLabelText(name) as HTMLInputElement;
  const type = (name: string | RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
  const checkbox = (name: RegExp) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
  return { addons, onClose, onStarted, dialog, button, field, type, checkbox, rerender };
}

/** First account through consent and iCloud, with the password the server refuses. */
async function refusedICloud() {
  const sheet = open({ kind: 'first' });
  sheet.addons.email.mailboxes.mockResolvedValueOnce(refused);
  fireEvent.click(sheet.button('Choose an account'));
  fireEvent.click(sheet.button('iCloud'));
  sheet.type('Email address', 'pat@example.com');
  sheet.type('App password', 'wrong-pass');
  fireEvent.click(sheet.button('Next'));
  await within(sheet.dialog).findByText('The server didn’t accept that address and app password.');
  return sheet;
}

/** Then a password that works, landing on the mailbox step. */
async function listedICloud() {
  const sheet = await refusedICloud();
  let answer: (value: typeof listed) => void = () => undefined;
  sheet.addons.email.mailboxes.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  sheet.type('App password', 'good-pass');
  fireEvent.click(sheet.button('Next'));
  await within(sheet.dialog).findByText('Getting email ready. The first time takes a few minutes.');
  answer(listed);
  await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
  return sheet;
}

describe('EmailConnectSheet', () => {
  it('first account: consent, iCloud, refused password shows the message and stays on the account step', async () => {
    const sheet = open({ kind: 'first' });
    for (const line of EMAIL_CONSENT) expect(within(sheet.dialog).getByText(line)).toBeTruthy();
    expect(EMAIL_CONSENT).toHaveLength(4);
    fireEvent.click(sheet.button('Choose an account'));
    for (const name of ['iCloud', 'Gmail', 'Fastmail', 'Yahoo', 'Other']) expect(sheet.button(name)).toBeTruthy();
    expect(within(sheet.dialog).queryByRole('button', { name: /Outlook/ })).toBeNull();
    fireEvent.click(sheet.button('iCloud'));
    expect(sheet.field('Name agents use').value).toBe('icloud');
    expect(sheet.field('App password').type).toBe('password');
    expect(sheet.field('App password').getAttribute('autocomplete')).toBe('off');
    expect(sheet.button('Next').disabled).toBe(true);
    sheet.addons.email.mailboxes.mockResolvedValueOnce(refused);
    sheet.type('Email address', 'pat@example.com');
    sheet.type('App password', 'wrong-pass');
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByText('The server didn’t accept that address and app password.');
    expect(sheet.addons.email.saveAccount).toHaveBeenCalledWith({
      slug: 'icloud',
      host: 'imap.mail.me.com',
      port: 993,
      security: 'tls',
      user: 'pat@example.com',
      address: 'pat@example.com',
      password: 'wrong-pass',
    });
    expect(sheet.addons.email.mailboxes).toHaveBeenCalledWith('icloud');
    // Still the account step, and the password is gone from the form.
    expect(sheet.field('Email address').value).toBe('pat@example.com');
    expect(sheet.field('App password').value).toBe('');
    expect(sheet.button('Next')).toBeTruthy();
  });

  it('iCloud opens the app-password walkthrough; others show their steps and a help link', async () => {
    const sheet = open({ kind: 'add' });
    fireEvent.click(sheet.button('Gmail'));
    expect(within(sheet.dialog).getByText('Create an app password, then copy it.')).toBeTruthy();
    fireEvent.click(sheet.button(/Gmail’s help page/));
    expect(window.electronAPI.urls.openUrl).toHaveBeenCalledWith('https://support.google.com/accounts/answer/185833');
    fireEvent.click(sheet.button('iCloud'));
    fireEvent.click(sheet.button('Show me how'));
    expect(within(sheet.dialog).getByRole('region', { name: /app-specific password/ })).toBeTruthy();
  });

  it('then a good password lists mailboxes with Inbox and Sent checked and Junk unchecked', async () => {
    const sheet = await listedICloud();
    expect(sheet.addons.email.saveAccount).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'good-pass' }));
    expect(sheet.checkbox(/Inbox/).checked).toBe(true);
    expect(sheet.checkbox(/Sent Messages/).checked).toBe(true);
    expect(sheet.checkbox(/Junk/).checked).toBe(false);
    expect(sheet.checkbox(/Projects\/Alpha/).checked).toBe(false);
    expect(within(sheet.dialog).getByText('1,204')).toBeTruthy();
    expect((within(sheet.dialog).getByRole('radio', { name: 'Last 90 days' }) as HTMLInputElement).checked).toBe(true);
    expect(sheet.checkbox(/Include attachment text/).checked).toBe(false);
  });

  it('Everything stores 1970-01-01 and Connect starts the install with the account', async () => {
    const sheet = await listedICloud();
    fireEvent.click(within(sheet.dialog).getByRole('radio', { name: 'Everything' }));
    expect(within(sheet.dialog).getByText('The first pass can take hours on a large mailbox.')).toBeTruthy();
    fireEvent.click(sheet.button('Connect'));
    await vi.waitFor(() => expect(sheet.onClose).toHaveBeenCalled());
    const email = sheet.addons.email;
    expect(email.setMailboxes).toHaveBeenCalledWith('icloud', ['INBOX', 'Sent Messages']);
    expect(email.setSettings).toHaveBeenCalledWith({ since: '1970-01-01', attachments: false, drafts: false });
    expect(email.setMailboxes.mock.invocationCallOrder[0]).toBeLessThan(email.setSettings.mock.invocationCallOrder[0]);
    expect(sheet.addons.install).toHaveBeenCalledWith('email', { email: { account: 'icloud' } });
    expect(sheet.onStarted).toHaveBeenCalled();
    expect(email.cancelAccount).not.toHaveBeenCalled();
  });

  it('Cancel after a refused login removes the new account', async () => {
    const sheet = await refusedICloud();
    fireEvent.click(sheet.button('Cancel'));
    expect(sheet.addons.email.cancelAccount).toHaveBeenCalledWith('icloud');
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('after Cancel, the new account’s name can be used again', async () => {
    const empty = overview({ since: '1970-01-01' });
    const sheet = open({ kind: 'add' }, empty);
    const { email } = sheet.addons;
    email.mailboxes.mockResolvedValueOnce(listed);
    fireEvent.click(sheet.button('Gmail'));
    sheet.type('Email address', 'sam@example.com');
    sheet.type('App password', 'app-pass');
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });

    // A refresh while the sheet is open lists the stored account, as main's would.
    email.refresh.mockResolvedValue(overview({ since: '1970-01-01', accounts: [account({ slug: 'gmail', state: 'waiting' })] }));
    await act(() => refreshEmail());
    email.refresh.mockResolvedValue(empty);
    const before = email.refresh.mock.calls.length;
    fireEvent.click(sheet.button('Cancel'));
    expect(email.cancelAccount).toHaveBeenCalledWith('gmail');
    await vi.waitFor(() => expect(email.refresh.mock.calls.length).toBe(before + 1));
    expect(email.cancelAccount.mock.invocationCallOrder[0]).toBeLessThan(email.refresh.mock.invocationCallOrder[before]);

    sheet.rerender(<EmailConnectSheet key="again" mode={{ kind: 'add' }} onClose={sheet.onClose} />);
    const again = screen.getByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Gmail' }));
    fireEvent.change(within(again).getByLabelText('Email address'), { target: { value: 'sam@example.com' } });
    fireEvent.change(within(again).getByLabelText('App password'), { target: { value: 'app-pass' } });
    expect(within(again).queryByText(/already connected/)).toBeNull();
    expect((within(again).getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Other offers Plain only for host.docker.internal', () => {
    const sheet = open({ kind: 'add' });
    fireEvent.click(sheet.button('Other'));
    expect(sheet.field('Name agents use').value).toBe('mail');
    const options = () => Array.from((sheet.field('Security') as unknown as HTMLSelectElement).options).map((o) => o.value);
    sheet.type('Server', 'imap.example.com');
    expect(options()).toEqual(['tls', 'starttls']);
    expect(within(sheet.dialog).queryByText('Proton Bridge through this is untested.')).toBeNull();
    sheet.type('Server', 'host.docker.internal');
    expect(options()).toEqual(['tls', 'starttls', 'plain']);
    expect(within(sheet.dialog).getByText('Proton Bridge through this is untested.')).toBeTruthy();
  });

  it('checks the name agents use before sending anything', () => {
    const sheet = open({ kind: 'add' });
    fireEvent.click(sheet.button('Fastmail'));
    sheet.type('Email address', 'pat@example.com');
    sheet.type('App password', 'app-pass');
    expect(sheet.button('Next').disabled).toBe(false);
    sheet.type('Name agents use', '1mail');
    expect(sheet.button('Next').disabled).toBe(true);
    fireEvent.click(sheet.button('Next'));
    expect(sheet.addons.email.saveAccount).not.toHaveBeenCalled();
  });

  it('Change password sends only the new password and keeps the other fields', async () => {
    const sheet = open({ kind: 'password', account: account() });
    expect(sheet.field('Server').value).toBe('imap.example.com');
    expect(sheet.field('Port').value).toBe('143');
    expect(sheet.field('User name').value).toBe('pat');
    expect(sheet.field('From address').value).toBe('pat@example.com');
    expect(sheet.field('Name agents use').value).toBe('work');
    expect(sheet.field('Password').value).toBe('');
    sheet.addons.email.mailboxes.mockResolvedValueOnce(listed);
    sheet.type('Password', 'new-pass');
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    expect(sheet.addons.email.saveAccount).toHaveBeenCalledWith({
      slug: 'work',
      host: 'imap.example.com',
      port: 143,
      security: 'starttls',
      user: 'pat',
      address: 'pat@example.com',
      password: 'new-pass',
    });
    // The stored mailboxes stay chosen.
    expect(sheet.checkbox(/Projects\/Alpha/).checked).toBe(true);
    expect(sheet.checkbox(/Sent Messages/).checked).toBe(false);
    fireEvent.click(sheet.button('Cancel'));
    expect(sheet.addons.email.cancelAccount).not.toHaveBeenCalled();
  });

  it('Change password without a new one keeps the stored password', async () => {
    const sheet = open({ kind: 'password', account: account() });
    sheet.addons.email.mailboxes.mockResolvedValueOnce(listed);
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    expect(sheet.addons.email.saveAccount).toHaveBeenCalledWith(expect.objectContaining({ slug: 'work', password: null }));
  });

  it('a second account shows the window as set and doesn’t send settings', async () => {
    const sheet = open(
      { kind: 'add' },
      overview({ enabled: true, since: '1970-01-01', accounts: [account({ slug: 'icloud', state: 'indexed' })] })
    );
    fireEvent.click(sheet.button('Gmail'));
    sheet.type('Email address', 'sam@example.com');
    sheet.type('App password', 'app-pass');
    sheet.addons.email.mailboxes.mockResolvedValueOnce(listed);
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    expect(within(sheet.dialog).getByText('These apply to every account. Change them on the Email page.')).toBeTruthy();
    expect(within(sheet.dialog).queryByRole('radio', { name: 'Everything' })).toBeNull();
    expect(within(sheet.dialog).getByText('Everything')).toBeTruthy();
    fireEvent.click(sheet.button('Connect'));
    await vi.waitFor(() => expect(sheet.onClose).toHaveBeenCalled());
    expect(sheet.addons.email.setMailboxes).toHaveBeenCalledWith('gmail', ['INBOX', 'Sent Messages']);
    expect(sheet.addons.email.setSettings).not.toHaveBeenCalled();
    expect(sheet.addons.install).not.toHaveBeenCalled();
    expect(sheet.addons.email.cancelAccount).not.toHaveBeenCalled();
  });

  it('won’t reuse the name of an account already connected', async () => {
    const sheet = open({ kind: 'add' }, overview({ since: '1970-01-01', accounts: [account({ slug: 'gmail' })] }));
    fireEvent.click(sheet.button('Gmail'));
    sheet.type('Email address', 'sam@example.com');
    sheet.type('App password', 'app-pass');
    await within(sheet.dialog).findByText(/An account named gmail is already connected/);
    expect(sheet.button('Next').disabled).toBe(true);
  });

  it('Mailboxes lists the account’s mailboxes with its stored ones checked and saves them', async () => {
    const sheet = open({ kind: 'mailboxes', account: account() }, overview({ enabled: true, since: '1970-01-01' }), (addons) =>
      addons.email.mailboxes.mockResolvedValueOnce(listed)
    );
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    expect(sheet.checkbox(/Projects\/Alpha/).checked).toBe(true);
    fireEvent.click(sheet.checkbox(/Junk/));
    fireEvent.click(sheet.button('Save'));
    await vi.waitFor(() => expect(sheet.onClose).toHaveBeenCalled());
    expect(sheet.addons.email.setMailboxes).toHaveBeenCalledWith('work', ['INBOX', 'Junk', 'Projects/Alpha']);
    expect(sheet.addons.email.saveAccount).not.toHaveBeenCalled();
  });
  it('preselects a mailbox the stack marks with its lowercase \\sent', async () => {
    const sheet = open({ kind: 'add' }, overview({ since: '1970-01-01' }));
    fireEvent.click(sheet.button('Gmail'));
    sheet.type('Email address', 'sam@example.com');
    sheet.type('App password', 'app-pass');
    sheet.addons.email.mailboxes.mockResolvedValueOnce({
      success: true,
      result: {
        ok: true,
        mailboxes: [
          { name: 'INBOX', messages: 2, specialUse: [] },
          { name: 'Gesendet', messages: 1, specialUse: ['\\sent'] },
        ],
      },
    });
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Gesendet/ });
    expect(sheet.checkbox(/Gesendet/).checked).toBe(true);
  });

  it('clears the password after saveAccount fails, and after it rejects', async () => {
    const sheet = open({ kind: 'add' });
    fireEvent.click(sheet.button('Gmail'));
    sheet.type('Email address', 'sam@example.com');
    sheet.addons.email.saveAccount.mockResolvedValueOnce(busyReply);
    sheet.type('App password', 'first-pass');
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByText(BUSY_TEXT);
    expect(sheet.field('App password').value).toBe('');
    expect(sheet.addons.email.mailboxes).not.toHaveBeenCalled();
    sheet.addons.email.saveAccount.mockRejectedValueOnce(new Error('main went away'));
    sheet.type('App password', 'second-pass');
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByText('main went away');
    expect(sheet.field('App password').value).toBe('');
    // Nothing was stored, so the password is needed again.
    expect(sheet.button('Next').disabled).toBe(true);
  });

  it('Cancel after a partial Connect removes the new account', async () => {
    const sheet = await listedICloud();
    sheet.addons.email.setSettings.mockResolvedValueOnce(busyReply);
    fireEvent.click(sheet.button('Connect'));
    await within(sheet.dialog).findByText(BUSY_TEXT);
    expect(sheet.addons.email.setMailboxes).toHaveBeenCalledWith('icloud', ['INBOX', 'Sent Messages']);
    expect(sheet.onClose).not.toHaveBeenCalled();
    fireEvent.click(sheet.button('Cancel'));
    expect(sheet.addons.email.removeAccount).toHaveBeenCalledWith('icloud');
    expect(sheet.addons.email.cancelAccount).not.toHaveBeenCalled();
    expect(sheet.addons.install).not.toHaveBeenCalled();
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('keeps Save off until the overview has loaded', async () => {
    const sheet = open({ kind: 'mailboxes', account: account() }, undefined, (addons) => {
      addons.email.overview.mockReturnValue(new Promise(() => undefined));
      addons.email.mailboxes.mockResolvedValueOnce(listed);
    });
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    expect(sheet.button('Save').disabled).toBe(true);
  });

  it('Mailboxes lists once per account, offers Try again, and Cancel never removes the account', async () => {
    const sheet = open({ kind: 'mailboxes', account: account() }, overview({ enabled: true, since: '1970-01-01' }), (addons) =>
      addons.email.mailboxes.mockResolvedValueOnce(busyReply).mockResolvedValueOnce(listed)
    );
    await within(sheet.dialog).findByText(BUSY_TEXT);
    fireEvent.click(sheet.button('Try again'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    fireEvent.click(sheet.checkbox(/Junk/));
    // An overview broadcast gives the parent a new object for the same account.
    sheet.rerender(<EmailConnectSheet mode={{ kind: 'mailboxes', account: account({ state: 'indexed' }) }} onClose={sheet.onClose} />);
    expect(sheet.addons.email.mailboxes).toHaveBeenCalledTimes(2);
    expect(sheet.checkbox(/Junk/).checked).toBe(true);
    fireEvent.click(sheet.button('Cancel'));
    expect(sheet.addons.email.cancelAccount).not.toHaveBeenCalled();
    expect(sheet.addons.email.removeAccount).not.toHaveBeenCalled();
    expect(sheet.onClose).toHaveBeenCalled();
  });

  it('Change password on a known provider keeps the stored user name', async () => {
    const stored = account({ slug: 'icloud', host: 'imap.mail.me.com', port: 993, security: 'tls', user: 'pat.appleid@example.com' });
    const sheet = open({ kind: 'password', account: stored });
    expect(sheet.field('Email address').value).toBe('pat@example.com');
    sheet.addons.email.mailboxes.mockResolvedValueOnce(listed);
    sheet.type('App password', 'new-pass');
    fireEvent.click(sheet.button('Next'));
    await within(sheet.dialog).findByRole('checkbox', { name: /Inbox/ });
    expect(sheet.addons.email.saveAccount).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'icloud', user: 'pat.appleid@example.com', address: 'pat@example.com', password: 'new-pass' })
    );
  });
});
