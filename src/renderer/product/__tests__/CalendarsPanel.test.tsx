import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { CalendarsPanel } from '../CalendarsPanel';

const calendarsApi = {
  list: vi.fn(),
  prepare: vi.fn(),
  test: vi.fn(),
  connect: vi.fn(),
  setAccess: vi.fn(),
  recheck: vi.fn(),
  recheckAll: vi.fn(),
  replacePassword: vi.fn(),
  remove: vi.fn(),
  onChanged: vi.fn(),
  onProgress: vi.fn(),
};
const agentsApi = { list: vi.fn() };

const agents = [
  { slug: 'assistant', displayName: 'Hermes', handle: 'hermes', role: '', builtIn: true, createdAt: '' },
  { slug: 'researcher', displayName: 'Researcher', handle: 'researcher', role: 'Web research', builtIn: false, createdAt: '' },
];

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

let progress: ((event: { slug: string; step: string }) => void) | null = null;

async function openSignIn() {
  render(<CalendarsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Apple ID email'), { target: { value: 'sam@example.com' } });
}

describe('CalendarsPanel', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    progress = null;
    stubElectronAPI({ calendars: calendarsApi, agents: agentsApi });
    agentsApi.list.mockResolvedValue({ success: true, agents, standingDmByAgent: {} });
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    calendarsApi.prepare.mockResolvedValue({ success: true });
    calendarsApi.recheckAll.mockImplementation(() => calendarsApi.list());
    calendarsApi.onChanged.mockReturnValue(() => undefined);
    calendarsApi.onProgress.mockImplementation((cb) => {
      progress = cb;
      return () => undefined;
    });
  });

  it('offers to connect when no calendar is connected', async () => {
    render(<CalendarsPanel />);
    expect(await screen.findByText('No calendars connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Connect calendar/ })).toBeTruthy();
  });

  it('starts the calendar service as soon as the sheet opens', async () => {
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    expect(calendarsApi.prepare).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Google Calendar.')).toBeTruthy();
  });

  it('warns about an Apple ID password before testing it', async () => {
    await openSignIn();
    fireEvent.change(screen.getByLabelText('App-specific password'), { target: { value: 'MyAppleIdPassword1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test sign-in' }));
    expect(await screen.findByText(/doesn’t look like an app-specific password/)).toBeTruthy();
    expect(calendarsApi.test).not.toHaveBeenCalled();

    calendarsApi.test.mockResolvedValue({ status: 'rejected' });
    fireEvent.click(screen.getByRole('button', { name: 'Test anyway' }));
    expect(await screen.findByText(/didn’t accept this username and password/)).toBeTruthy();
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
    act(() => progress?.({ slug: 'personal', step: 'access' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByLabelText('Apple ID email'), { target: { value: 'sam@example.com' } });
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
      return () => undefined;
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
    expect((screen.getByLabelText('Apple ID email') as HTMLInputElement).disabled).toBe(true);
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

  it('opened from the chat card, starts on the sheet and goes back to the chat when cancelled', async () => {
    const back = vi.fn();
    render(<CalendarsPanel onConnectFromChatClosed={back} />);
    expect(await screen.findByText('Where is your calendar?')).toBeTruthy();
    await waitFor(() => expect(calendarsApi.prepare).toHaveBeenCalled());
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
});
