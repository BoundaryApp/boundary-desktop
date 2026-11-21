import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantUiServiceCard } from '../../../shared/types/assistantStack';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { AssistantServicesScreen } from '../AssistantServicesScreen';
import { lightragListing, listing, localWorkspace, n8nListing, stubAddons } from '../addons/__tests__/addonFixtures';
import { buildAssistantUiServiceCards } from '../../../shared/assistantUiServices';
import { openMenu } from '../../__tests__/openMenu';

/** n8n, LightRAG and Neo4j as main sends them in the status. */
function addonServices(ports: Record<string, number>): AssistantUiServiceCard[] {
  return buildAssistantUiServiceCards((key, path) => `http://127.0.0.1:${ports[key]}${path}`).filter((card) =>
    ['n8n', 'lightrag', 'neo4j'].includes(card.id)
  );
}

let stackReady = true;
const STACK_PORTS = vi.hoisted(() => ({ n8n: 5678, lightrag: 9621, neo4jHttp: 7474 }));
let uiServices: AssistantUiServiceCard[] = [];
vi.mock('../assistantStack', () => ({
  useAssistantStackStatus: () => ({
    ready: stackReady,
    uiServices: uiServices,
    addonServices: addonServices(STACK_PORTS),
    ports: STACK_PORTS,
  }),
  refreshAssistantStackStatus: async (): Promise<void> => undefined,
}));

const ensureRunning = vi.fn();
const openUrl = vi.fn();
stubElectronAPI({
  assistantStack: {
    ensureRunning: () => ensureRunning(),
    getStatus: async () => ({ ready: true, addonServices: addonServices(STACK_PORTS), ports: STACK_PORTS }),
  },
});

const calendarsApi = { list: vi.fn(), onChanged: vi.fn(), macStatus: vi.fn() };

const account = (status: 'ok' | 'rejected' | 'unreachable') => ({
  slug: 'personal',
  name: 'Personal',
  lastCheck: { at: '2026-10-25T10:00:00Z', status },
});

/** A tile's button, found by the service's name. */
const tile = (name: string) => screen.findByRole('button', { name });

/** Opens a tile's menu from its ⋯ button. */
async function tileMenu(name: string) {
  openMenu(await screen.findByRole('button', { name: `More for ${name}` }));
  return within(await screen.findByRole('menu', { name }));
}

function stubCalendars(accounts: unknown[] = []) {
  calendarsApi.list.mockResolvedValue({ success: true, accounts });
  calendarsApi.onChanged.mockReturnValue((): void => undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubElectronAPI({ calendars: calendarsApi, urls: { openUrl: (url: string) => openUrl(url) } });
  stubCalendars();
  openUrl.mockResolvedValue({ success: true });
});

afterEach(() => {
  uiServices = [];
  stackReady = true;
});

describe('Services: built in', () => {
  it('shows the stack’s services as tiles that open in the browser', async () => {
    uiServices = [
      { id: 'searxng', title: 'SearXNG', description: 'Local meta-search.', url: 'http://127.0.0.1:8888/' },
    ] as AssistantUiServiceCard[];
    render(<AssistantServicesScreen />);
    const row = within(screen.getByRole('list', { name: 'Built in' }));
    const searx = row.getByRole('button', { name: 'SearXNG' });
    expect(searx.textContent).toContain('Running');
    fireEvent.click(searx);
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:8888/'));
  });

  it('dims the tiles while the assistant is stopped', () => {
    stackReady = false;
    uiServices = [
      { id: 'searxng', title: 'SearXNG', description: 'Local meta-search.', url: 'http://127.0.0.1:8888/' },
    ] as AssistantUiServiceCard[];
    render(<AssistantServicesScreen />);
    const searx = screen.getByRole('button', { name: 'SearXNG' }) as HTMLButtonElement;
    expect(searx.disabled).toBe(true);
    expect(searx.textContent).toContain('Stopped');
  });
});

describe('Services: Calendar', () => {
  it('is off until a calendar is connected, and opens Settings → Calendars', async () => {
    const opened = vi.fn();
    const listener = (event: Event) => opened((event as CustomEvent).detail);
    window.addEventListener('boundary:open-settings', listener);
    render(<AssistantServicesScreen />);
    const calendar = await tile('Calendar');
    expect(calendar.textContent).toContain('Off');
    const menu = await tileMenu('Calendar');
    expect(menu.getByText('Starts when you connect a calendar')).toBeTruthy();
    fireEvent.click(menu.getByRole('menuitem', { name: 'Connect calendar' }));
    fireEvent.click(calendar);
    window.removeEventListener('boundary:open-settings', listener);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledWith({ tab: 'calendars' });
  });

  it('shows the accounts’ status when connected', async () => {
    stubCalendars([account('ok')]);
    render(<AssistantServicesScreen />);
    expect((await tile('Calendar')).textContent).toContain('Connected');
    const menu = await tileMenu('Calendar');
    expect(menu.getByText('CalDAV bridge · Personal')).toBeTruthy();
    expect(menu.getByRole('menuitem', { name: 'Manage calendars' })).toBeTruthy();
    cleanup();

    stubCalendars([account('rejected')]);
    render(<AssistantServicesScreen />);
    expect((await tile('Calendar')).textContent).toContain('Sign-in failed');
    expect(calendarsApi.macStatus).not.toHaveBeenCalled();
  });

  it('lists the Mac calendars and helper status in the Calendar menu', async () => {
    const mac = {
      slug: 'mac',
      name: 'This Mac',
      provider: 'mac',
      lastCheck: { at: '2026-11-08T10:00:00Z', status: 'ok' },
      allowedCalendarIds: ['c1', 'c3'],
    };
    const calendars = [
      { id: 'c1', title: 'Home', color: '#3366cc', source: 'iCloud', kind: 'icloud', writable: true },
      { id: 'c2', title: 'Birthdays', color: '#999999', source: 'iCloud', kind: 'birthdays', writable: false },
      { id: 'c3', title: 'Team', color: '#cc6633', source: 'Work Exchange', kind: 'exchange', writable: true },
    ];
    stubCalendars([{ ...account('ok'), provider: 'icloud' }, mac]);
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars });
    render(<AssistantServicesScreen />);
    let menu = await tileMenu('Calendar');
    expect(menu.getByText('CalDAV bridge · Personal')).toBeTruthy();
    expect(await menu.findByText('This Mac · Home, Team')).toBeTruthy();
    expect(menu.getByText('Calendar helper running')).toBeTruthy();
    expect((await tile('Calendar')).textContent).toContain('Connected');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    calendarsApi.macStatus.mockResolvedValue({ access: 'stopped', calendars: [] });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(async () => expect((await tile('Calendar')).textContent).toContain('Helper stopped'));
    menu = await tileMenu('Calendar');
    expect(menu.getByText('Calendar helper stopped')).toBeTruthy();
    // Without a list, the line counts the ticked calendars.
    expect(menu.getByText('This Mac · 2 calendars')).toBeTruthy();
  });
});

describe('Services: Start assistant', () => {
  it('starts the stack from Not ready', () => {
    stackReady = false;
    ensureRunning.mockResolvedValue({ success: false, error: 'compose failed' });
    render(<AssistantServicesScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Start assistant' }));
    expect(ensureRunning).toHaveBeenCalledTimes(1);
  });
});

describe('Services: add-ons', () => {
  it('shows installed add-ons as tiles without opening the store, and opens one', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    render(<AssistantServicesScreen />);
    const row = within(await screen.findByRole('list', { name: 'Add-ons' }));
    const twenty = await row.findByRole('button', { name: 'Twenty CRM' });
    expect(twenty.textContent).toContain('Running');
    fireEvent.click(twenty);
    await waitFor(() => expect(addons.twenty.open).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: 'Services' })).toBeTruthy();
  });

  it('leaves out what isn’t installed, and the Get add-ons tile opens the store', async () => {
    stubAddons([listing(), n8nListing()]);
    render(<AssistantServicesScreen />);
    const row = within(await screen.findByRole('list', { name: 'Add-ons' }));
    const get = await row.findByRole('button', { name: 'Get add-ons' });
    expect(row.queryByRole('button', { name: 'Twenty CRM' })).toBeNull();
    expect(row.queryByRole('button', { name: 'n8n' })).toBeNull();
    expect(get.textContent).toContain('2 more in the store');
    fireEvent.click(get);
    expect(await screen.findByRole('heading', { name: 'Discover' })).toBeTruthy();
  });

  it('opens an add-on’s page in the store from its menu, and comes back', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    render(<AssistantServicesScreen />);
    const menu = await tileMenu('Twenty CRM');
    expect(menu.getByRole('menuitem', { name: 'Open' })).toBeTruthy();
    fireEvent.click(menu.getByRole('menuitem', { name: 'Details' }));
    fireEvent.click(await screen.findByRole('button', { name: '← Services' }));
    expect(await screen.findByRole('heading', { name: 'Services' })).toBeTruthy();
  });
});

describe('Services: n8n and LightRAG', () => {
  it('opens n8n from its tile, with Details and no Turn off in its menu', async () => {
    stubAddons([n8nListing(true)]);
    render(<AssistantServicesScreen />);
    fireEvent.click(await tile('n8n'));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:5678/'));
    const menu = await tileMenu('n8n');
    expect(menu.getByRole('menuitem', { name: 'Details' })).toBeTruthy();
    // Turning an add-on off asks first, on its page.
    expect(menu.queryByRole('menuitem', { name: 'Turn off' })).toBeNull();
  });

  it('opens LightRAG and the Neo4j browser while it runs', async () => {
    stubAddons([lightragListing(true)]);
    render(<AssistantServicesScreen />);
    fireEvent.click(await tile('LightRAG'));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:9621/webui/'));
    const menu = await tileMenu('LightRAG');
    fireEvent.click(menu.getByRole('menuitem', { name: 'Open Neo4j' }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:7474/'));
  });

  it('leaves them off Services while they’re off', async () => {
    stubAddons([n8nListing(), lightragListing()]);
    render(<AssistantServicesScreen />);
    const row = within(await screen.findByRole('list', { name: 'Add-ons' }));
    await row.findByRole('button', { name: 'Get add-ons' });
    expect(row.queryByRole('button', { name: 'n8n' })).toBeNull();
    expect(row.queryByRole('button', { name: 'LightRAG' })).toBeNull();
  });
});
