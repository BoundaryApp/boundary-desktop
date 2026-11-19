import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarsPanel } from '../CalendarsPanel';
import { calendarsApi, macAccount, macCalendars, openSignIn, reportProgress, stubCalendars } from './calendarsHarness';

const personal = {
  slug: 'personal',
  name: 'Personal',
  provider: 'icloud',
  url: 'https://caldav.icloud.com/',
  username: 'sam@example.com',
  passwordTail: 'mnop',
  calendars: [
    { name: 'Home', url: 'https://caldav.icloud.com/1/home/' },
    { name: 'Work', url: 'https://caldav.icloud.com/1/work/' },
  ],
  access: { assistant: 'read', researcher: 'off' },
  createdAt: '2026-10-21T10:00:00Z',
  lastCheck: { at: '2026-10-21T10:00:00Z', status: 'ok' },
  lastOkAt: '2026-10-21T10:00:00Z',
};

describe('CalendarsPanel', () => {
  beforeEach(stubCalendars);

  it('offers to connect when no calendar is connected', async () => {
    render(<CalendarsPanel />);
    expect(await screen.findByText('No calendars connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect calendar/ })).toBeTruthy();
  });

  it('selects Calendars on this Mac by default and leaves the calendar service alone', async () => {
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    expect(screen.getByRole('radio', { name: /^Calendars on this Mac/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Google Calendar.')).toBeTruthy();
    await act(async () => undefined);
    expect(calendarsApi.prepare).not.toHaveBeenCalled();
  });

  it('starts the calendar service once a CalDAV provider is picked, and only once', async () => {
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^iCloud/ }));
    await waitFor(() => expect(calendarsApi.prepare).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('radio', { name: /^Calendars on this Mac/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Fastmail/ }));
    await act(async () => undefined);
    expect(calendarsApi.prepare).toHaveBeenCalledTimes(1);
  });

  it('selects iCloud by default and starts the calendar service when a Mac account exists', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [macAccount] });
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect another calendar' }));
    expect(screen.getByRole('radio', { name: /^iCloud/ }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(calendarsApi.prepare).toHaveBeenCalledTimes(1));
  });

  it('opened from the chat before the list loads, moves to iCloud when a Mac account turns up', async () => {
    let answer!: (value: unknown) => void;
    calendarsApi.list.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    render(<CalendarsPanel onConnectFromChatClosed={vi.fn()} />);
    expect(screen.getByRole('radio', { name: /^Calendars on this Mac/ }).getAttribute('aria-checked')).toBe('true');
    await act(async () => answer({ success: true, accounts: [macAccount] }));
    await waitFor(() => expect(screen.getByRole('radio', { name: /^iCloud/ }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.queryByRole('radio', { name: /^Calendars on this Mac/ })).toBeNull();
    await waitFor(() => expect(calendarsApi.prepare).toHaveBeenCalledTimes(1));
  });

  it('warns about an Apple Account password before testing it', async () => {
    await openSignIn();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'MyAppleIdPassword1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test sign-in' }));
    expect(await screen.findByText(/doesn’t look like an app-specific password/)).toBeTruthy();
    expect(calendarsApi.test).not.toHaveBeenCalled();

    calendarsApi.test.mockResolvedValue({ status: 'rejected' });
    fireEvent.click(screen.getByRole('button', { name: 'Test anyway' }));
    expect(await screen.findByText(/didn’t accept this username and password/)).toBeTruthy();
  });

  it('shows Show me how instead of the collapsed list on the iCloud sign-in step', async () => {
    await openSignIn();
    expect(screen.queryByText('How do I get an app-specific password?')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show me how' })).toBeTruthy();
    expect(screen.getByText(/two-factor authentication turned on first/)).toBeTruthy();
  });

  it('fills the password field from the walkthrough', async () => {
    await openSignIn();
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect((screen.getByLabelText('App-specific password') as HTMLInputElement).value).toBe('abcd-efgh-ijkl-mnop');
    expect((screen.getByLabelText('Apple Account email') as HTMLInputElement).value).toBe('sam@example.com');
  });

  it('closes only the walkthrough on Escape and leaves the sign-in step open', async () => {
    await openSignIn();
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByText('Open account.apple.com', { selector: 'h3' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', bubbles: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show me how' })).toBeTruthy();
    expect(screen.getByText('Sign in to iCloud')).toBeTruthy();
    // With the walkthrough closed, Escape closes the sheet as before.
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the Fastmail help list unchanged', async () => {
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Fastmail/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('How do I get an app password?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show me how' })).toBeNull();
  });

  it('refuses a password Hermes can’t pass on', async () => {
    await openSignIn();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'has space' } });
    expect(screen.getByText(/can’t pass on a password with spaces/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Test sign-in' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('connects after a good test, with Hermes on Read and change and other agents off', async () => {
    calendarsApi.test.mockResolvedValue({
      status: 'ok',
      url: 'https://caldav.icloud.com/',
      calendars: personal.calendars,
    });
    calendarsApi.connect.mockResolvedValue({
      success: true,
      account: { ...personal, access: { assistant: 'change', researcher: 'off' } },
    });
    await openSignIn();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test sign-in' }));
    expect(await screen.findByText(/Signed in. Agents will see these 2 calendars/)).toBeTruthy();
    expect(calendarsApi.test).toHaveBeenCalledWith({
      provider: 'icloud',
      url: '',
      username: 'sam@example.com',
      password: 'abcd-efgh-ijkl-mnop',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Who can use Personal?')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Hermes access' }).querySelector('[aria-pressed="true"]')?.textContent).toBe(
      'Read and change'
    );
    expect(screen.getByRole('group', { name: 'Researcher access' }).querySelector('[aria-pressed="true"]')?.textContent).toBe('Off');

    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    act(() => reportProgress({ slug: 'personal', step: 'access' }));
    expect(await screen.findByText('Personal connected. Hermes can read it and asks before changes.')).toBeTruthy();
    expect(calendarsApi.connect).toHaveBeenCalledWith({
      provider: 'icloud',
      url: '',
      username: 'sam@example.com',
      password: 'abcd-efgh-ijkl-mnop',
      name: 'Personal',
      access: { assistant: 'change', researcher: 'off' },
    });
  });

  it('offers Off, Read, and Read and change per agent', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    calendarsApi.setAccess.mockResolvedValue({ success: true, account: personal });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change access' }));
    const group = screen.getByRole('group', { name: 'Researcher access' });
    expect(Array.from(group.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Off', 'Read', 'Read and change']);
    fireEvent.click(within(group).getByRole('button', { name: 'Read and change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calendarsApi.setAccess).toHaveBeenCalledWith({ slug: 'personal', access: { assistant: 'read', researcher: 'change' } })
    );
  });

  it('shows the cloud notice when an agent with access runs on a cloud model', async () => {
    calendarsApi.test.mockResolvedValue({ status: 'ok', url: 'https://caldav.icloud.com/', calendars: [] });
    render(<CalendarsPanel cloudProvider="OpenRouter" />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^iCloud/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Apple Account email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'abcd-efgh-ijkl-mnop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test sign-in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/OpenRouter runs in the cloud/)).toBeTruthy();
  });

  it('shows a connected account and removes it after confirming', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    calendarsApi.remove.mockResolvedValue({ success: true });
    render(<CalendarsPanel />);
    expect(await screen.findByText('“Check my Personal calendar”')).toBeTruthy();
    expect(screen.getByText('•••• mnop')).toBeTruthy();
    expect(screen.getByText('Hermes: read')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('alertdialog', { name: 'Remove Personal' })).toBeTruthy();
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Personal' }));
    await waitFor(() => expect(calendarsApi.remove).toHaveBeenCalledWith({ slug: 'personal' }));
    expect(await screen.findByText('Removed Personal')).toBeTruthy();
  });

  it('closes the remove confirm on Escape, but not while a sheet is open over it', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    render(<CalendarsPanel />);
    await screen.findByText('“Check my Personal calendar”');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect another calendar' }));
    expect(screen.getByText('Where is your calendar?')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(screen.queryByText('Where is your calendar?')).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'Remove Personal' })).toBeTruthy();
    expect(calendarsApi.remove).not.toHaveBeenCalled();
  });

  it('tests every sign-in when the tab opens and turns a rejected one red', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    const rejected = {
      ...personal,
      access: { assistant: 'change', researcher: 'off' },
      lastCheck: { at: '2026-10-24T08:00:00Z', status: 'rejected' },
      lastOkAt: '2026-10-18T09:00:00Z',
    };
    calendarsApi.recheckAll.mockResolvedValue({ success: true, accounts: [rejected] });
    render(<CalendarsPanel />);
    expect(await screen.findByText('Sign-in failed')).toBeTruthy();
    expect(calendarsApi.recheckAll).toHaveBeenCalledTimes(1);
    const lastWorked = new Date('2026-10-18T09:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(screen.getByText(`Last worked ${lastWorked}`)).toBeTruthy();
    expect(screen.getByText(/cancels every app-specific password/)).toBeTruthy();
    expect(screen.getByText('Hermes: read and change')).toBeTruthy();
    // Replace password leads, and Test gives way to it.
    const actions = screen.getAllByRole('button').map((b) => b.textContent);
    expect(actions.indexOf('Replace password')).toBeLessThan(actions.indexOf('Change access'));
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
  });

  it('refreshes when the daily check changes a card', async () => {
    let changed: (() => void) | null = null;
    calendarsApi.onChanged.mockImplementation((cb: () => void) => {
      changed = cb;
      return (): void => undefined;
    });
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    render(<CalendarsPanel />);
    await screen.findByText('Connected');
    calendarsApi.list.mockResolvedValue({
      success: true,
      accounts: [{ ...personal, lastCheck: { at: '2026-10-24T08:00:00Z', status: 'rejected' } }],
    });
    act(() => changed?.());
    expect(await screen.findByText('Sign-in failed')).toBeTruthy();
  });

  it('replaces the password through the sign-in test', async () => {
    const rejected = { ...personal, lastCheck: { at: '2026-10-24T08:00:00Z', status: 'rejected' } };
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [rejected] });
    calendarsApi.test.mockResolvedValue({ status: 'ok', url: personal.url, calendars: personal.calendars });
    calendarsApi.replacePassword.mockResolvedValue({ success: true, account: personal });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace password' }));

    expect(screen.getByText('Replace the Personal password')).toBeTruthy();
    expect((screen.getByLabelText('Apple Account email') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Name')).toBeNull();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'qrst-uvwx-yzab-cdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test sign-in' }));
    expect(await screen.findByText(/Signed in/)).toBeTruthy();
    expect(calendarsApi.test).toHaveBeenCalledWith({
      provider: 'icloud',
      url: personal.url,
      username: 'sam@example.com',
      password: 'qrst-uvwx-yzab-cdef',
    });

    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    fireEvent.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await screen.findByText('Replaced the Personal password')).toBeTruthy();
    expect(calendarsApi.replacePassword).toHaveBeenCalledWith({ slug: 'personal', password: 'qrst-uvwx-yzab-cdef' });
  });

  it('offers the walkthrough when replacing an iCloud password', async () => {
    const rejected = { ...personal, lastCheck: { at: '2026-10-24T08:00:00Z', status: 'rejected' } };
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [rejected] });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace password' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'qrst-uvwx-yzab-cdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Replace the Personal password')).toBeTruthy();
    expect((screen.getByLabelText('App-specific password') as HTMLInputElement).value).toBe('qrst-uvwx-yzab-cdef');
  });

  it('opened from the chat card, starts on the sheet and goes back to the chat when cancelled', async () => {
    const back = vi.fn();
    render(<CalendarsPanel onConnectFromChatClosed={back} />);
    expect(await screen.findByText('Where is your calendar?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a sheet opened from the tab itself stays in Settings when cancelled', async () => {
    const back = vi.fn();
    render(<CalendarsPanel onConnectFromChatClosed={back} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('names the dialog while the walkthrough shows', async () => {
    await openSignIn();
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    expect(screen.getByRole('dialog', { name: 'Open account.apple.com' })).toBeTruthy();
  });
});
