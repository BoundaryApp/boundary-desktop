import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppCommand } from '../../../shared/appCommands';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductSettingsScreen } from '../ProductSettingsScreen';
import { useAppCommand } from '../useAppShortcuts';

describe('ProductSettingsScreen', () => {
  afterEach(() => cleanup());

  it('sends models to Inference', async () => {
    stubElectronAPI({ onboarding: { getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }) } });
    const received: AppCommand[] = [];
    const Listener = () => {
      useAppCommand((command) => received.push(command));
      return null;
    };
    render(
      <>
        <Listener />
        <ProductSettingsScreen onBack={() => undefined} />
      </>
    );
    expect(screen.queryByText('Scan this machine')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Inference' }));
    expect(received).toEqual(['go-inference']);
  });

  it('holds the Circles profile: the name, the connection and the diagnostics file', async () => {
    const revealDiagnostics = vi.fn().mockResolvedValue({ success: false, error: 'No file yet.' });
    stubElectronAPI({
      onboarding: { getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }) },
      circles: {
        getState: vi.fn().mockResolvedValue({
          status: 'running',
          displayName: 'Ada',
          snapshot: { identity: 'a'.repeat(64), circles: [] },
          providers: {},
          sharing: { models: [], circles: [], paused: false, away: false },
        }),
        revealDiagnostics,
      },
    });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    const section = screen.getByRole('region', { name: 'Circles' });
    expect(await within(section).findByText('Ada · Connected')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Profile…' }));
    const sheet = screen.getByRole('dialog', { name: 'Circles profile' });
    expect((within(sheet).getByLabelText('Your name in Circles') as HTMLInputElement).value).toBe('Ada');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Show diagnostics file' }));
    expect(await within(sheet).findByText('No file yet.')).toBeTruthy();
  });
});
