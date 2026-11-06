import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { AssistantServicesScreen } from '../AssistantServicesScreen';

let stackReady = true;
let n8nStatus: { enabled: boolean; canToggle: boolean } | undefined;
let lightragStatus: { enabled: boolean; canToggle: boolean } | undefined;
vi.mock('../assistantStack', () => ({
  useAssistantStackStatus: () => ({
    ready: stackReady,
    uiServices: [],
    ports: { n8n: 5678, lightrag: 9621, neo4jHttp: 7474 },
    n8n: n8nStatus,
    lightrag: lightragStatus,
  }),
  refreshAssistantStackStatus: async () => undefined,
}));

const ensureRunning = vi.fn();
const setN8nEnabled = vi.fn();
const setLightragEnabled = vi.fn();
const openUrl = vi.fn();
stubElectronAPI({
  assistantStack: {
    ensureRunning: () => ensureRunning(),
    setN8nEnabled: (enabled: boolean) => setN8nEnabled(enabled),
    setLightragEnabled: (enabled: boolean) => setLightragEnabled(enabled),
  },
});

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

describe('Services: n8n', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubElectronAPI({ calendars: calendarsApi, urls: { openUrl: (url: string) => openUrl(url) } });
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    calendarsApi.onChanged.mockReturnValue(() => undefined);
  });

  afterEach(() => {
    n8nStatus = undefined;
    stackReady = true;
    cleanup();
  });

  function n8nCard() {
    render(<AssistantServicesScreen />);
    return within(screen.getByRole('region', { name: 'n8n' }));
  }

  it('is off until turned on, and turns it on', async () => {
    n8nStatus = { enabled: false, canToggle: true };
    setN8nEnabled.mockResolvedValue({ success: true });
    const card = n8nCard();
    expect(card.getByText('Off')).toBeTruthy();
    expect(card.queryByRole('button', { name: 'Open' })).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(setN8nEnabled).toHaveBeenCalledWith(true));
  });

  it('shows why n8n didn’t change', async () => {
    n8nStatus = { enabled: false, canToggle: true };
    setN8nEnabled.mockResolvedValue({ success: false, error: 'Couldn’t start n8n. pull failed' });
    const card = n8nCard();
    fireEvent.click(card.getByRole('button', { name: 'Turn on' }));
    expect(await card.findByText('Couldn’t start n8n. pull failed')).toBeTruthy();
  });

  it('opens n8n and turns it off while it runs', async () => {
    n8nStatus = { enabled: true, canToggle: true };
    openUrl.mockResolvedValue({ success: true });
    setN8nEnabled.mockResolvedValue({ success: true });
    const card = n8nCard();
    expect(card.getByText('On')).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:5678/'));
    fireEvent.click(card.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(setN8nEnabled).toHaveBeenCalledWith(false));
  });

  it('has no switch under dev:local-stack, where the stack’s .env decides', () => {
    n8nStatus = { enabled: true, canToggle: false };
    const card = n8nCard();
    expect(card.getByText('Set by the local stack’s .env (AUTOMATION_ENABLED).')).toBeTruthy();
    expect(card.queryByRole('button', { name: /Turn/ })).toBeNull();
  });
});

describe('Services: LightRAG', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubElectronAPI({ calendars: calendarsApi, urls: { openUrl: (url: string) => openUrl(url) } });
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [] });
    calendarsApi.onChanged.mockReturnValue(() => undefined);
  });

  afterEach(() => {
    lightragStatus = undefined;
    stackReady = true;
    cleanup();
  });

  function lightragCard() {
    render(<AssistantServicesScreen />);
    return within(screen.getByRole('region', { name: 'LightRAG' }));
  }

  it('is off until turned on, says it restarts the assistant, and turns it on', async () => {
    lightragStatus = { enabled: false, canToggle: true };
    setLightragEnabled.mockResolvedValue({ success: true });
    const card = lightragCard();
    expect(card.getByText('Off')).toBeTruthy();
    expect(card.getByText(/Turning it on restarts your assistant\./)).toBeTruthy();
    expect(card.queryByRole('button', { name: /Open/ })).toBeNull();
    fireEvent.click(card.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(setLightragEnabled).toHaveBeenCalledWith(true));
  });

  it('shows why LightRAG didn’t change', async () => {
    lightragStatus = { enabled: false, canToggle: true };
    setLightragEnabled.mockResolvedValue({
      success: false,
      error: 'Couldn’t start LightRAG. pull failed',
    });
    const card = lightragCard();
    fireEvent.click(card.getByRole('button', { name: 'Turn on' }));
    expect(await card.findByText('Couldn’t start LightRAG. pull failed')).toBeTruthy();
  });

  it('opens LightRAG and the Neo4j browser, and turns it off, while it runs', async () => {
    lightragStatus = { enabled: true, canToggle: true };
    openUrl.mockResolvedValue({ success: true });
    setLightragEnabled.mockResolvedValue({ success: true });
    const card = lightragCard();
    expect(card.getByText('On')).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Open LightRAG' }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:9621/webui/'));
    fireEvent.click(card.getByRole('button', { name: 'Open Neo4j' }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:7474/'));
    fireEvent.click(card.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(setLightragEnabled).toHaveBeenCalledWith(false));
  });

  it('has no switch under dev:local-stack, where the stack’s .env decides', () => {
    lightragStatus = { enabled: true, canToggle: false };
    const card = lightragCard();
    expect(card.getByText('Set by the local stack’s .env (COMPOSE_PROFILES).')).toBeTruthy();
    expect(card.queryByRole('button', { name: /Turn/ })).toBeNull();
  });
});
