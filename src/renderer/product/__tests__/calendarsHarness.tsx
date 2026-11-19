import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { CalendarAccountView } from '../../../shared/types/calendars';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { CalendarsPanel } from '../CalendarsPanel';

/** The calendars bridge CalendarsPanel calls; each test sets what main answers. */
export const calendarsApi = {
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
  macStatus: vi.fn(),
  macRequestAccess: vi.fn(),
  macConnect: vi.fn(),
  macSetCalendars: vi.fn(),
  openPrivacySettings: vi.fn(),
  macRestartHelper: vi.fn(),
};
export const urlsApi = { openUrl: vi.fn() };
const agentsApi = { list: vi.fn() };

const agents = [
  { slug: 'assistant', displayName: 'Hermes', handle: 'hermes', role: '', builtIn: true, createdAt: '' },
  { slug: 'researcher', displayName: 'Researcher', handle: 'researcher', role: 'Web research', builtIn: false, createdAt: '' },
];

export const macCalendars = [
  { id: 'c1', title: 'Home', color: '#3366cc', source: 'iCloud', kind: 'icloud', writable: true },
  { id: 'c2', title: 'Birthdays', color: '#999999', source: 'iCloud', kind: 'birthdays', writable: false },
  { id: 'c3', title: 'Team', color: '#cc6633', source: 'Work Exchange', kind: 'exchange', writable: true },
  { id: 'c4', title: 'Moon phases', color: '#66aa66', source: 'Subscribed', kind: 'subscribed', writable: false },
];
export const macAccount: CalendarAccountView = {
  slug: 'mac',
  name: 'This Mac',
  provider: 'mac',
  url: '',
  username: '',
  passwordTail: '',
  calendars: [],
  access: { assistant: 'read', researcher: 'off' },
  createdAt: '2026-11-08T10:00:00Z',
  lastCheck: { at: '2026-11-08T10:00:00Z', status: 'ok' },
  lastOkAt: '2026-11-08T10:00:00Z',
  allowedCalendarIds: ['c1', 'c3'],
};

let progress: ((event: { slug: string; step: string }) => void) | null = null;

/** Sends a connect step to the panel, as main does while it connects an account. */
export function reportProgress(event: { slug: string; step: string }): void {
  progress?.(event);
}

/** No accounts, two agents, and a calendar service that prepares and opens links without fuss. */
export function stubCalendars(): void {
  vi.clearAllMocks();
  progress = null;
  stubElectronAPI({ calendars: calendarsApi, agents: agentsApi, urls: urlsApi });
  urlsApi.openUrl.mockResolvedValue({ success: true });
  calendarsApi.openPrivacySettings.mockResolvedValue({ success: true });
  agentsApi.list.mockResolvedValue({ success: true, agents, standingDmByAgent: {} });
  calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
  calendarsApi.prepare.mockResolvedValue({ success: true });
  calendarsApi.recheckAll.mockImplementation(() => calendarsApi.list());
  calendarsApi.onChanged.mockReturnValue((): void => undefined);
  calendarsApi.onProgress.mockImplementation((cb) => {
    progress = cb;
    return (): void => undefined;
  });
}

/** Opens the sheet on Calendars on this Mac, at the access step. */
export async function openMacAllow() {
  render(<CalendarsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
  fireEvent.click(screen.getByRole('radio', { name: /^Calendars on this Mac/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

/** Opens the sheet on iCloud's sign-in step with the email filled in. */
export async function openSignIn() {
  render(<CalendarsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
  fireEvent.click(screen.getByRole('radio', { name: /^iCloud/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Apple Account email'), { target: { value: 'sam@example.com' } });
}
