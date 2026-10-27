import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { AssistantServicesScreen } from '../AssistantServicesScreen';

let stackReady = true;
vi.mock('../assistantStack', () => ({
  useAssistantStackStatus: () => ({ ready: stackReady, uiServices: [] }),
  refreshAssistantStackStatus: async () => undefined,
}));

const ensureRunning = vi.fn();
stubElectronAPI({ assistantStack: { ensureRunning: () => ensureRunning() } });

const calendarsApi = { list: vi.fn(), onChanged: vi.fn() };

const account = (status: 'ok' | 'rejected' | 'unreachable') => ({
  slug: 'personal',
  name: 'Personal',
  lastCheck: { at: '2026-10-25T10:00:00Z', status },
});

async function calendarCard() {
  render(<AssistantServicesScreen />);
  return within(await screen.findByRole('region', { name: 'Calendar' }));
}

describe('Services: Calendar', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    stubElectronAPI({ calendars: calendarsApi });
    calendarsApi.onChanged.mockReturnValue(() => undefined);
  });

  it('says it starts when you connect a calendar, and links to Settings → Calendars', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    const opened = vi.fn();
    const listener = (event: Event) => opened((event as CustomEvent).detail);
    window.addEventListener('boundary:open-settings', listener);
    const card = await calendarCard();
    expect(card.getByText('Starts when you connect a calendar')).toBeTruthy();
    expect(card.getByText('Off')).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Connect calendar' }));
    window.removeEventListener('boundary:open-settings', listener);
    expect(opened).toHaveBeenCalledWith({ tab: 'calendars' });
  });

  it('shows the accounts’ status when connected', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [account('ok')] });
    let card = await calendarCard();
    expect(card.getByText('CalDAV bridge · Personal')).toBeTruthy();
    expect(card.getByText('Connected')).toBeTruthy();
    expect(card.getByRole('button', { name: 'Manage calendars' })).toBeTruthy();
    cleanup();

    calendarsApi.list.mockResolvedValue({ success: true, accounts: [account('rejected')] });
    card = await calendarCard();
    expect(card.getByText('Sign-in failed')).toBeTruthy();
  });
});

describe('Services: Start assistant', () => {
  afterEach(() => {
    stackReady = true;
    cleanup();
  });

  it('starts the stack from Not ready', () => {
    stackReady = false;
    stubElectronAPI({ calendars: calendarsApi });
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    calendarsApi.onChanged.mockReturnValue(() => undefined);
    ensureRunning.mockResolvedValue({ success: false, error: 'compose failed' });
    render(<AssistantServicesScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Start assistant' }));
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });
});
