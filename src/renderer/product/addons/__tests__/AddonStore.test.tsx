import React, { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { AssistantServicesScreen } from '../../AssistantServicesScreen';
import { AddonStore, type StorePage } from '../AddonStore';
import { startAddonInstall } from '../useAddons';
import { replied } from '../../../__tests__/mockReplies';
import {
  actualListing,
  hostedWorkspace,
  lightragListing,
  listing,
  localWorkspace,
  n8nListing,
  snapshot,
  stubAddons,
} from './addonFixtures';
import { buildAssistantUiServiceCards } from '../../../../shared/assistantUiServices';
import type { AssistantUiServiceCard } from '../../../../shared/types/assistantStack';

/** n8n, LightRAG and Neo4j as main sends them in the status. */
function addonServices(ports: Record<string, number>): AssistantUiServiceCard[] {
  return buildAssistantUiServiceCards((key, path) => `http://127.0.0.1:${ports[key]}${path}`).filter((card) =>
    ['n8n', 'lightrag', 'neo4j'].includes(card.id)
  );
}

const stack: {
  status: { ready: boolean; uiServices: never[]; addonServices: AssistantUiServiceCard[]; ports: Record<string, number> };
} = {
  status: { ready: true, uiServices: [], addonServices: [], ports: {} },
};

vi.mock('../../assistantStack', () => ({
  useAssistantStackStatus: () => stack.status,
  refreshAssistantStackStatus: async () => {},
}));

beforeEach(() => {
  const ports = { n8n: 5678, lightrag: 9621, neo4jHttp: 7474 };
  stack.status = { ready: true, uiServices: [], addonServices: addonServices(ports), ports };
});

/** The store with its own page state, as the Services screen holds it. */
const Store: React.FC<{ start?: StorePage }> = ({ start = { view: 'discover' } }) => {
  const [page, setPage] = useState<StorePage>(start);
  return <AddonStore page={page} go={setPage} onServices={() => undefined} />;
};

const card = (name: string) => screen.findByRole('button', { name });

describe('Services entry', () => {
  const calendars = { list: async () => ({ success: true, accounts: [] as never[] }), onChanged: () => () => {} };

  it('shows no Add-ons entry when there is nothing to offer', async () => {
    const addons = stubAddons([]);
    stubElectronAPI({ calendars });
    render(<AssistantServicesScreen />);
    await screen.findByRole('button', { name: 'Calendar' });
    await replied(addons.list);
    expect(screen.queryByRole('heading', { name: 'Add-ons' })).toBeNull();
  });

  it('opens the store on Discover, and goes back to Services', async () => {
    stubAddons([listing()]);
    stubElectronAPI({ calendars });
    render(<AssistantServicesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add-on store' }));
    expect(await screen.findByRole('heading', { name: 'Discover' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Featured: Twenty CRM' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Services' }));
    expect(await screen.findByRole('heading', { name: 'Services' })).toBeTruthy();
  });
});

describe('store cards', () => {
  it('installs Twenty from the Get sheet with the access choice, and shows the install', async () => {
    const addons = stubAddons([listing()]);
    addons.install.mockReturnValue(new Promise(() => undefined));
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    expect(within(twenty).getByText('2.2 GB memory')).toBeTruthy();
    fireEvent.click(within(twenty).getByRole('button', { name: 'Get Twenty CRM' }));
    const choice = await screen.findByRole('dialog', { name: 'Get Twenty CRM' });
    fireEvent.click(within(choice).getByRole('button', { name: /^Run it on this Mac/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Install Twenty CRM?' });
    expect(within(sheet).getByText(/Fits, with 3\.0 GB left\./)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('radio', { name: /Look things up/ }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Install' }));
    expect(addons.install).toHaveBeenCalledWith('twenty', { access: 'read' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Installing Twenty CRM' })).toBeTruthy();
    // Back on the category page, the card shows the run.
    fireEvent.click(screen.getByRole('button', { name: /Work & CRM/ }));
    expect(within(await card('Twenty CRM')).getByText('Installing')).toBeTruthy();
    expect(within(await card('Twenty CRM')).getByRole('status').textContent).toBe('0%');
  });

  it('asks how to use Twenty before anything else, with neither way picked', async () => {
    const addons = stubAddons([listing()]);
    render(<Store start={{ view: 'category', category: 'work' }} />);
    fireEvent.click(within(await card('Twenty CRM')).getByRole('button', { name: 'Get Twenty CRM' }));
    const choice = await screen.findByRole('dialog', { name: 'Get Twenty CRM' });
    const ways = within(within(choice).getByRole('group', { name: 'How to use it' })).getAllByRole('button');
    expect(ways.map((w) => w.querySelector('span')?.textContent)).toEqual([
      'Run it on this Mac',
      'Connect one you already use',
    ]);
    // Only Cancel acts on the sheet: the cards are the choice.
    expect(within(choice).queryByRole('button', { name: 'Install' })).toBeNull();
    expect(addons.install).not.toHaveBeenCalled();
  });

  it('opens Twenty’s connect form from the choice, and Change goes back to it', async () => {
    const addons = stubAddons([listing()]);
    render(<Store start={{ view: 'category', category: 'work' }} />);
    fireEvent.click(within(await card('Twenty CRM')).getByRole('button', { name: 'Get Twenty CRM' }));
    const choice = await screen.findByRole('dialog', { name: 'Get Twenty CRM' });
    fireEvent.click(within(choice).getByRole('button', { name: /^Connect one you already use/ }));
    const connect = await screen.findByRole('dialog', { name: 'Connect a hosted Twenty workspace' });
    expect(within(connect).getByLabelText('Twenty address')).toBeTruthy();
    expect(connect.className).toContain('wb-sheet-still');
    fireEvent.click(within(connect).getByRole('button', { name: '← Change' }));
    expect(await screen.findByRole('dialog', { name: 'Get Twenty CRM' })).toBeTruthy();
    expect(addons.install).not.toHaveBeenCalled();
  });

  it('opens Actual’s connect form from the choice with the server address first', async () => {
    const addons = stubAddons([actualListing()]);
    render(<Store start={{ view: 'category', category: 'money' }} />);
    fireEvent.click(within(await card('Actual Budget')).getByRole('button', { name: 'Get Actual Budget' }));
    const choice = await screen.findByRole('dialog', { name: 'Get Actual Budget' });
    fireEvent.click(within(choice).getByRole('button', { name: /^Connect one you already use/ }));
    const connect = await screen.findByRole('dialog', { name: 'Connect a budget' });
    expect(within(connect).getByLabelText('Server address')).toBeTruthy();
    expect(within(connect).getByLabelText('Server password')).toBeTruthy();
    expect(addons.install).not.toHaveBeenCalled();
  });

  it('installs Actual from the choice at Look things up, and Change goes back', async () => {
    const addons = stubAddons([actualListing()]);
    addons.install.mockReturnValue(new Promise(() => undefined));
    render(<Store start={{ view: 'category', category: 'money' }} />);
    fireEvent.click(within(await card('Actual Budget')).getByRole('button', { name: 'Get Actual Budget' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Get Actual Budget' })).getByRole('button', { name: /^Run it on this Mac/ }));
    let sheet = await screen.findByRole('dialog', { name: 'Install Actual Budget?' });
    fireEvent.click(within(sheet).getByRole('button', { name: '← Change' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Get Actual Budget' })).getByRole('button', { name: /^Run it on this Mac/ }));
    sheet = await screen.findByRole('dialog', { name: 'Install Actual Budget?' });
    expect(within(sheet).getByText(/^0\.6 GB download\./)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Install' }));
    expect(addons.install).toHaveBeenCalledWith('actual', { access: 'read' });
  });

  it('shows the install instead of the detail page while it runs, and the detail page once it ends', async () => {
    const addons = stubAddons([listing()], { current: snapshot('download', 'running') });
    render(<Store start={{ view: 'detail', id: 'twenty' }} />);
    expect(await screen.findByRole('heading', { name: 'Installing Twenty CRM' })).toBeTruthy();
    act(() => addons.emit({ ...snapshot('download', 'cancelled'), cancelled: true, done: true }));
    fireEvent.click(await screen.findByRole('button', { name: /Back to Twenty CRM/ }));
    expect(await screen.findByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeTruthy();
  });

  it('opens the install view from a card while an install runs', async () => {
    stubAddons([listing()], { current: snapshot('download', 'running') });
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    expect(await within(twenty).findByText('4%')).toBeTruthy();
    expect(twenty.querySelector('[data-mark="Working"]')).toBeTruthy();
    fireEvent.click(twenty);
    expect(await screen.findByRole('heading', { name: 'Installing Twenty CRM' })).toBeTruthy();
  });

  it('marks an installed Twenty and opens it signed in', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    expect(within(twenty).getByText('Installed')).toBeTruthy();
    expect(twenty.querySelector('[data-mark="Installed"]')).toBeTruthy();
    fireEvent.click(within(twenty).getByRole('button', { name: 'Open Twenty CRM' }));
    await vi.waitFor(() => expect(addons.twenty.open).toHaveBeenCalled());
  });

  it('leaves Enter and Space on the card’s action to the action, and opens the page from the card itself', async () => {
    stubAddons([listing()]);
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    const get = within(twenty).getByRole('button', { name: 'Get Twenty CRM' });
    // fireEvent returns false when a handler called preventDefault, which would stop the button's click.
    expect(fireEvent.keyDown(get, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(get, { key: ' ' })).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeNull();
    expect(fireEvent.keyDown(twenty, { key: ' ' })).toBe(false);
    expect(await screen.findByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeTruthy();
  });

  it('offers Start for an installed Twenty that isn’t running', async () => {
    const addons = stubAddons([listing({}, true, true, false, true)], { workspaces: [localWorkspace()] });
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    expect(within(twenty).getByText('Installed · not running')).toBeTruthy();
    fireEvent.click(within(twenty).getByRole('button', { name: 'Start Twenty CRM' }));
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledWith('twenty'));
  });

  it('turns a parked Twenty back on without asking for access again', async () => {
    const addons = stubAddons([listing()], { workspaces: [localWorkspace()] });
    addons.install.mockReturnValue(new Promise(() => undefined));
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    expect(await within(twenty).findByText('Off · data kept')).toBeTruthy();
    fireEvent.click(within(twenty).getByRole('button', { name: 'Turn on Twenty CRM' }));
    const sheet = await screen.findByRole('dialog', { name: 'Turn on Twenty CRM?' });
    expect(within(sheet).queryByRole('radiogroup')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Turn on' }));
    expect(addons.install).toHaveBeenCalledWith('twenty');
  });

  it.each([
    ['Install didn’t finish', listing({}, false, true, true), {}],
    ['Connected', listing(), { workspaces: [hostedWorkspace('work')] }],
    ['Won’t fit', listing({ usedMiB: 11800 }), {}],
    [
      'Install failed',
      listing(),
      { current: snapshot('setup', 'error', { error: { step: 'setup' as const, message: 'x', logTail: [] } }) },
    ],
  ])('reads %s and opens the detail page from View', async (line, entry, options) => {
    stubAddons([entry], options);
    render(<Store start={{ view: 'category', category: 'work' }} />);
    const twenty = await card('Twenty CRM');
    expect(await within(twenty).findByText(line)).toBeTruthy();
    fireEvent.click(within(twenty).getByRole('button', { name: 'View Twenty CRM' }));
    expect(await screen.findByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeTruthy();
  });

  it('keeps an install it already shows when a late snapshot reply is null', async () => {
    const addons = stubAddons([listing()]);
    let answer: (s: null) => void = () => undefined;
    addons.snapshot.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    addons.install.mockReturnValue(new Promise(() => undefined));
    render(<Store start={{ view: 'category', category: 'work' }} />);
    await screen.findByRole('button', { name: 'Get Twenty CRM' });
    act(() => startAddonInstall('twenty'));
    expect(screen.getByText('Installing')).toBeTruthy();
    await act(async () => answer(null));
    expect(screen.getByText('Installing')).toBeTruthy();
  });
});

describe('restart bar', () => {
  it('restarts the assistant for an install that waits on it', async () => {
    const addons = stubAddons([listing()], { current: snapshot('restart', 'waiting') });
    render(<Store />);
    const bar = await screen.findByRole('status', { name: 'Restart the assistant to finish' });
    expect(within(bar).getByText('Twenty CRM is ready.')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Restart assistant' }));
    expect(addons.restart).toHaveBeenCalledWith('twenty');
  });

  it('offers to wait while agent work runs', async () => {
    const work = [{ id: 'task:1', kind: 'coding' as const, title: 'Inbox cleanup', detail: 'Coding task' }];
    stubAddons([listing()], { current: snapshot('restart', 'waiting'), work });
    render(<Store />);
    const bar = await screen.findByRole('status', { name: 'Restart the assistant to finish' });
    expect(await within(bar).findByRole('button', { name: 'Restart when the task finishes' })).toBeTruthy();
    expect(within(bar).getByText(/Running now: Inbox cleanup\./)).toBeTruthy();
  });
});

describe('n8n and LightRAG', () => {
  it('lists them as add-ons, and n8n’s Get on its page turns it on through addon.sh', async () => {
    const addons = stubAddons([listing(), n8nListing(), lightragListing(true)]);
    render(<Store />);
    const n8n = await card('n8n');
    expect(within(n8n).queryByText('Included')).toBeNull();
    expect(within(await card('LightRAG')).getByRole('button', { name: 'Open LightRAG' })).toBeTruthy();
    fireEvent.click(within(n8n).getByRole('button', { name: 'Get n8n' }));
    expect(await screen.findByRole('heading', { name: 'n8n', level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Get' }));
    expect(addons.install).toHaveBeenCalledWith('n8n');
  });

  it('opens n8n’s editor from its page and offers Turn off and Remove while it runs', async () => {
    stubAddons([n8nListing(true)]);
    const openUrl = vi.fn(async () => ({ success: true }));
    stubElectronAPI({ urls: { openUrl } });
    render(<Store start={{ view: 'detail', id: 'n8n' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open n8n' }));
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:5678/');
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove and delete data' })).toBeTruthy();
  });

  it('turns n8n back on, with its workflows kept, from its page', async () => {
    const addons = stubAddons([n8nListing(false, true)]);
    render(<Store />);
    fireEvent.click(within(await card('n8n')).getByRole('button', { name: 'Turn on n8n' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await act(async () => {});
    expect(addons.start).toHaveBeenCalledWith('n8n');
  });

  it('opens LightRAG and Neo4j from LightRAG’s page, with Turn off and no Remove', async () => {
    stubAddons([lightragListing(true)]);
    const openUrl = vi.fn(async () => ({ success: true }));
    stubElectronAPI({ urls: { openUrl } });
    render(<Store start={{ view: 'detail', id: 'lightrag' }} />);
    expect(await screen.findByRole('button', { name: /Open LightRAG/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open Neo4j/ }));
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining(':7474'));
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove and delete data' })).toBeNull();
  });
});

describe('Installed page', () => {
  it('lists what runs with its status and the engine memory it reserves', async () => {
    stubAddons([listing({}, true), n8nListing(true), lightragListing()], { workspaces: [localWorkspace()] });
    render(<Store start={{ view: 'installed' }} />);
    const list = await screen.findByRole('list', { name: 'Installed add-ons' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getAllByText('Running')).toHaveLength(2);
    expect(screen.getByText('2 running')).toBeTruthy();
    expect(screen.getByText('3.2 GB of engine memory reserved')).toBeTruthy();
    const installedNav = screen.getByRole('button', { name: /Installed/ , current: 'page' });
    expect(within(installedNav).getByText('2')).toBeTruthy();
  });

  it('opens a row on Enter or Space, and leaves those keys to the row’s action', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    render(<Store start={{ view: 'installed' }} />);
    const list = await screen.findByRole('list', { name: 'Installed add-ons' });
    const row = within(list).getByRole('button', { name: 'Twenty CRM' });
    const open = within(row).getByRole('button', { name: 'Open Twenty CRM' });
    expect(fireEvent.keyDown(open, { key: 'Enter' })).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeNull();
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false);
    expect(await screen.findByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeTruthy();
  });

  it('points to Discover when nothing is installed', async () => {
    stubAddons([listing()]);
    render(<Store start={{ view: 'installed' }} />);
    expect(await screen.findByRole('heading', { name: 'No add-ons yet' })).toBeTruthy();
  });
});

describe('search and filters', () => {
  const type = (text: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Search add-ons' }), { target: { value: text } });

  it('finds Twenty by what it’s for, and opening a result ends the search', async () => {
    stubAddons([listing(), n8nListing()]);
    render(<Store />);
    await screen.findByRole('heading', { name: 'Discover' });
    type('contacts');
    expect(screen.getByRole('heading', { name: '1 add-on for “contacts”' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Discover' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Twenty CRM' }));
    expect(await screen.findByRole('heading', { name: 'Twenty CRM', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Search add-ons' })).toBeNull();
  });

  it('lists what Boundary already runs and goes there', async () => {
    stubAddons([listing()]);
    const onServices = vi.fn();
    const Wrapped = () => {
      const [page, setPage] = useState<StorePage>({ view: 'discover' });
      return <AddonStore page={page} go={setPage} onServices={onServices} />;
    };
    render(<Wrapped />);
    await screen.findByRole('heading', { name: 'Discover' });
    type('web search');
    expect(screen.getByRole('heading', { name: 'No add-on for “web search” yet' })).toBeTruthy();
    const built = screen.getByRole('region', { name: 'Already in Boundary' });
    fireEvent.click(within(built).getByRole('button', { name: 'Go to Web search' }));
    expect(onServices).toHaveBeenCalled();
  });

  it('focuses the field with / and clears it with Escape', async () => {
    stubAddons([listing()]);
    render(<Store />);
    await screen.findByRole('heading', { name: 'Discover' });
    const field = screen.getByRole('textbox', { name: 'Search add-ons' });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(field);
    type('crm');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect((field as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('heading', { name: 'Discover' })).toBeTruthy();
  });

  it('filters Discover and says how many results the filters hide', async () => {
    stubAddons([listing({ usedMiB: 11800 }), n8nListing(), lightragListing()]);
    render(<Store />);
    await screen.findByRole('region', { name: 'Featured: Twenty CRM' });
    const filters = screen.getByRole('group', { name: 'Filters' });
    fireEvent.click(within(filters).getByRole('button', { name: 'Fits this Mac' }));
    expect(within(filters).getByRole('button', { name: 'Fits this Mac', pressed: true })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Featured: Twenty CRM' })).toBeNull();
    fireEvent.click(within(filters).getByRole('button', { name: 'Stays on this Mac' }));
    // LightRAG is now the first one not installed, so it's featured; n8n leaves this Mac.
    expect(screen.queryByRole('button', { name: 'n8n' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Featured: LightRAG' })).toBeTruthy();
    type('crm');
    expect(screen.getByRole('heading', { name: '0 add-ons for “crm”' })).toBeTruthy();
    expect(screen.getByText('1 more hidden by filters')).toBeTruthy();
  });

  it('says so when the filters leave Discover empty', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    render(<Store />);
    await card('Twenty CRM');
    fireEvent.click(screen.getByRole('button', { name: 'Hide installed' }));
    expect(screen.getByText('Nothing matches these filters. Turn one off to see more.')).toBeTruthy();
  });
});
