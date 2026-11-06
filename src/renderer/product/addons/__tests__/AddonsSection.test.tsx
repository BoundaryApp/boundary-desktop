import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { AssistantServicesScreen } from '../../AssistantServicesScreen';
import { AddonsSection } from '../AddonsSection';
import { startAddonInstall } from '../useAddons';
import { listing, snapshot, stubAddons } from './addonFixtures';

vi.mock('../../assistantStack', () => ({
  useAssistantStackStatus: () => ({ ready: true, uiServices: [] }),
  refreshAssistantStackStatus: async () => undefined,
}));

afterEach(() => cleanup());

describe('Add-ons in Services', () => {
  it('Services shows no Add-ons section when the catalog is empty', async () => {
    const addons = stubAddons([]);
    stubElectronAPI({
      calendars: { list: async () => ({ success: true, accounts: [] }), onChanged: () => () => undefined },
    });
    render(<AssistantServicesScreen />);
    await screen.findByRole('region', { name: 'Calendar' });
    await vi.waitFor(() => expect(addons.list).toHaveBeenCalled());
    expect(screen.queryByRole('heading', { name: 'Add-ons' })).toBeNull();
  });

  it("marks Twenty's card when an install left containers behind", async () => {
    stubAddons([listing({}, false, true, true)]);
    render(<AddonsSection onOpen={vi.fn()} />);
    const card = await screen.findByRole('button', { name: /Twenty CRM/ });
    expect(within(card).getByText('Install didn’t finish')).toBeTruthy();
  });

  it('shows Twenty with Fits this Mac', async () => {
    stubAddons([listing()]);
    const onOpen = vi.fn();
    render(<AddonsSection onOpen={onOpen} />);
    const card = await screen.findByRole('button', { name: /Twenty CRM/ });
    expect(within(card).getByText('Fits this Mac')).toBeTruthy();
    expect(within(card).getByText('2.2 GB memory · 1.1 GB download')).toBeTruthy();
    expect(screen.getByText('Container engine memory')).toBeTruthy();
    expect(screen.getByText('6.8 of 12.0 GB in use · 5.2 GB free')).toBeTruthy();
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith('twenty');
  });

  it('marks the card On when installed', async () => {
    stubAddons([listing({}, true)]);
    render(<AddonsSection onOpen={() => undefined} />);
    expect(await screen.findByText('On')).toBeTruthy();
  });

  it('marks the card Install failed while a failed install waits', async () => {
    stubAddons([listing()], {
      current: snapshot('setup', 'error', {
        error: { step: 'setup', message: 'exited with code 1', logTail: [] },
      }),
    });
    render(<AddonsSection onOpen={() => undefined} />);
    expect(await screen.findByText('Install failed')).toBeTruthy();
  });

  it('opens the install view from the card while an install is under way', async () => {
    stubAddons([listing()], { current: snapshot('download', 'running') });
    stubElectronAPI({
      calendars: { list: async () => ({ success: true, accounts: [] }), onChanged: () => () => undefined },
    });
    render(<AssistantServicesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /Twenty CRM.*Installing/ }));
    expect(await screen.findByRole('heading', { name: 'Installing Twenty CRM' })).toBeTruthy();
  });

  it('keeps an install it already shows when a late snapshot reply is null', async () => {
    const addons = stubAddons([listing()]);
    let answer: (s: null) => void = () => undefined;
    addons.snapshot.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    addons.install.mockReturnValue(new Promise(() => undefined));
    render(<AddonsSection onOpen={() => undefined} />);
    await screen.findByText('Fits this Mac');
    act(() => startAddonInstall('twenty'));
    expect(screen.getByText('Installing')).toBeTruthy();
    await act(async () => answer(null));
    expect(screen.getByText('Installing')).toBeTruthy();
  });
});
