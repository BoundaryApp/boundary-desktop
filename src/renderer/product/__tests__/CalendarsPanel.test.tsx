import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarsPanel } from '../CalendarsPanel';

const calendarsApi = {
  list: vi.fn(),
  prepare: vi.fn(),
  test: vi.fn(),
  connect: vi.fn(),
  setAccess: vi.fn(),
  recheck: vi.fn(),
  remove: vi.fn(),
  onProgress: vi.fn(),
};
const chatApi = { listAgents: vi.fn() };

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
    Object.defineProperty(window, 'electronAPI', {
      value: { calendars: calendarsApi, hermesChat: chatApi },
      configurable: true,
    });
    chatApi.listAgents.mockResolvedValue({ success: true, agents, standingDmByAgent: {} });
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    calendarsApi.prepare.mockResolvedValue({ success: true });
    calendarsApi.onProgress.mockImplementation((cb) => {
      progress = cb;
      return () => undefined;
    });
  });

  it('lists the three steps when no calendar is connected', async () => {
    render(<CalendarsPanel />);
    expect(await screen.findByText('No calendars connected')).toBeTruthy();
    expect(screen.getByText('Sign in with an app password from that provider.')).toBeTruthy();
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

  it('connects after a good test, with Hermes reading and other agents off', async () => {
    calendarsApi.test.mockResolvedValue({
      status: 'ok',
      url: 'https://caldav.icloud.com/',
      calendars: personal.calendars,
    });
    calendarsApi.connect.mockResolvedValue({ success: true, account: personal });
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
    expect(screen.getByRole('group', { name: 'Hermes access' }).querySelector('[aria-pressed="true"]')?.textContent).toBe('Read');
    expect(screen.getByRole('group', { name: 'Researcher access' }).querySelector('[aria-pressed="true"]')?.textContent).toBe('Off');

    calendarsApi.list.mockResolvedValue({ success: true, accounts: [personal] });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    act(() => progress?.({ slug: 'personal', step: 'access' }));
    expect(await screen.findByText('Personal connected. Hermes can read it.')).toBeTruthy();
    expect(calendarsApi.connect).toHaveBeenCalledWith({
      provider: 'icloud',
      url: '',
      username: 'sam@example.com',
      password: 'abcd-efgh-ijkl-mnop',
      name: 'Personal',
      access: { assistant: 'read', researcher: 'off' },
    });
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

  it('turns the card red when the password stopped working', async () => {
    calendarsApi.list.mockResolvedValue({
      success: true,
      accounts: [{ ...personal, lastCheck: { at: '2026-10-21T10:00:00Z', status: 'rejected' } }],
    });
    render(<CalendarsPanel />);
    expect(await screen.findByText('Sign-in failed')).toBeTruthy();
    expect(screen.getByText(/Changing your Apple ID password cancels every app-specific password/)).toBeTruthy();
  });
});
