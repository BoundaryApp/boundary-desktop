import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddonDetail } from '../AddonDetail';
import { addonStoreItem } from '../storeItems';
import { stubAddons, vikunjaListing } from './addonFixtures';

// Todo lists' page against a fake main: Get while off, Open while on, and the Remove sheet.

vi.mock('../../assistantStack', () => ({ useAssistantStackLifecycle: () => ({ phase: 'ready' }) }));

afterEach(() => cleanup());

const renderPage = () => render(<AddonDetail id="vikunja" onBack={() => undefined} onInstallStarted={() => undefined} />);

describe('VikunjaDetail', () => {
  it('offers Get while off with nothing left, and Get runs the install', async () => {
    const addons = stubAddons([vikunjaListing(false)]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Get' }));
    await vi.waitFor(() => expect(addons.install).toHaveBeenCalledWith('vikunja'));
    expect(screen.queryByRole('button', { name: 'Open todo lists' })).toBeNull();
  });

  it('opens the web app through main while on', async () => {
    const addons = stubAddons([vikunjaListing(true, true)]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Open todo lists' }));
    await vi.waitFor(() => expect(addons.vikunja.open).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Get' })).toBeNull();
  });

  it('shows main’s line when it can’t open', async () => {
    const addons = stubAddons([vikunjaListing(true, true)]);
    addons.vikunja.open.mockResolvedValueOnce({ success: false, error: 'Todo lists isn’t running. Start it, then open it.' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Open todo lists' }));
    expect(await screen.findByText('Todo lists isn’t running. Start it, then open it.')).toBeTruthy();
  });

  it('offers Turn on and Remove while off with lists left', async () => {
    const addons = stubAddons([vikunjaListing(false, true)]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }));
    await vi.waitFor(() => expect(addons.start).toHaveBeenCalledWith('vikunja'));
    expect(screen.queryByRole('button', { name: 'Get' })).toBeNull();
  });

  it('removes only after typing delete, and says the lists go', async () => {
    const addons = stubAddons([vikunjaListing(true, true)]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Remove and delete data/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/deletes every list, task and comment/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Remove and delete data' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(addons.remove).toHaveBeenCalledWith('vikunja', expect.anything()));
  });
});

describe('Todo lists in the store', () => {
  it('is a Work item that stays on this Mac, and off with lists left reads as off-data', () => {
    const item = addonStoreItem(vikunjaListing(false), null, null);
    expect(item).toMatchObject({ key: 'vikunja', name: 'Todo lists', category: 'work', staysLocal: true, state: { kind: 'get' } });
    expect(addonStoreItem(vikunjaListing(false, true), null, null).state).toEqual({ kind: 'off-data' });
    expect(addonStoreItem(vikunjaListing(true, true), null, null).state).toEqual({ kind: 'on', canOpen: true });
  });
});
