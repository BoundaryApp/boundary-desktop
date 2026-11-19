import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POOL_SETTINGS, type PoolSettings } from '../../../../shared/types/confidential';
import type { ConfidentialState } from '../../../../shared/types/confidentialState';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import { PoolSettingsSheet } from '../PoolSettingsSheet';

function stateWith(settings: PoolSettings): ConfidentialState {
  return {
    enabled: true,
    catalog: { available: true, publishedAt: '2026-11-08T00:00:00Z', stale: false, signatureFailed: false },
    models: [],
    providers: [],
    settings,
  };
}

async function mount(settings: PoolSettings = DEFAULT_POOL_SETTINGS) {
  const state = stateWith(settings);
  const api = stubElectronAPI({
    confidential: { getState: vi.fn().mockResolvedValue(state), setSettings: vi.fn().mockResolvedValue(state) },
  });
  const onClose = vi.fn();
  const onOpenHelp = vi.fn();
  render(<PoolSettingsSheet open onClose={onClose} onOpenHelp={onOpenHelp} />);
  await act(async () => undefined);
  return { api, onClose, onOpenHelp };
}

const dialog = () => screen.getByRole('dialog', { name: 'Pool settings' });

describe('PoolSettingsSheet', () => {
  beforeEach(() => resetIpcStoresForTests());

  it('shows the current settings', async () => {
    await mount({ ...DEFAULT_POOL_SETTINGS, chatFloor: 'B', privateFloor: 'A', lowestPrecision: 'fp4', allowUnstatedPrecision: false });
    const chats = within(within(dialog()).getByRole('radiogroup', { name: 'Lowest trust level for chats' }));
    expect((chats.getByLabelText(/Level B or better/) as HTMLInputElement).checked).toBe(true);
    const projects = within(within(dialog()).getByRole('radiogroup', { name: 'Lowest trust level for private projects' }));
    expect((projects.getByLabelText(/Level A only/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog()).getByLabelText('Lowest precision') as HTMLSelectElement).value).toBe('fp4');
    expect(
      within(dialog()).getByRole('switch', { name: 'Use providers that don’t state their precision' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(within(dialog()).getByText('A project can allow a lower level in its own settings.')).toBeTruthy();
  });

  it('saves a new chat floor', async () => {
    const { api } = await mount();
    const chats = within(within(dialog()).getByRole('radiogroup', { name: 'Lowest trust level for chats' }));
    await act(async () => {
      fireEvent.click(chats.getByLabelText(/Any level/));
    });
    expect(api.confidential.setSettings).toHaveBeenCalledWith({ ...DEFAULT_POOL_SETTINGS, chatFloor: 'C' });
  });

  it('hides the threshold with Prefer one provider off', async () => {
    await mount({ ...DEFAULT_POOL_SETTINGS, preferOneProvider: false });
    expect(within(dialog()).queryByRole('combobox', { name: /cheaper by more than/ })).toBeNull();
  });

  it('shows the threshold with Prefer one provider on', async () => {
    await mount({ ...DEFAULT_POOL_SETTINGS, preferOneProvider: true, preferThresholdPercent: 10 });
    expect((within(dialog()).getByRole('combobox', { name: /cheaper by more than/ }) as HTMLSelectElement).value).toBe('10');
  });

  it('saves the threshold and the switch', async () => {
    const { api } = await mount({ ...DEFAULT_POOL_SETTINGS, preferOneProvider: true });
    await act(async () => {
      fireEvent.change(within(dialog()).getByRole('combobox', { name: /cheaper by more than/ }), { target: { value: '50' } });
    });
    expect(api.confidential.setSettings).toHaveBeenLastCalledWith({
      ...DEFAULT_POOL_SETTINGS,
      preferOneProvider: true,
      preferThresholdPercent: 50,
    });
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('switch', { name: 'Prefer one provider' }));
    });
    expect(api.confidential.setSettings).toHaveBeenLastCalledWith({ ...DEFAULT_POOL_SETTINGS, preferOneProvider: false });
  });

  it('opens How pools work from the footer', async () => {
    const { onOpenHelp } = await mount();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'How pools work' }));
    expect(onOpenHelp).toHaveBeenCalled();
  });

  it('closes with Done', async () => {
    const { onClose } = await mount();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
