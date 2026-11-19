import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppCommand } from '../../../shared/appCommands';
import { runningCircles } from '../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductSettingsScreen } from '../ProductSettingsScreen';
import { useAppCommand } from '../useAppShortcuts';

describe('ProductSettingsScreen', () => {
  it('sends models to Inference', async () => {
    stubElectronAPI({ onboarding: { getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }) } });
    const received: AppCommand[] = [];
    const Listener = (): null => {
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
        getState: vi.fn().mockResolvedValue(runningCircles({ circles: [] })),
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
  it('shows General for a tab it does not know', async () => {
    stubElectronAPI({ onboarding: { getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }) } });
    render(<ProductSettingsScreen onBack={() => undefined} initialTab={'no-such-tab' as unknown as 'updates'} />);
    expect(await screen.findByRole('button', { name: 'Open Inference' })).toBeTruthy();
  });

  it('has a Writing voices tab', async () => {
    stubElectronAPI({
      onboarding: { getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }) },
      writingVoices: { list: vi.fn().mockResolvedValue({ success: true, voices: [] }) },
    });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Writing voices' }));
    expect(await screen.findByText('No writing voices yet.')).toBeTruthy();
  });
  const status = { getStatus: vi.fn().mockResolvedValue({ configured: false, encryptionAvailable: true, appDefault: null, slots: {} }) };

  it('shows Keep the agent button on the desktop where the platform has it, and turns it on', async () => {
    let changed: ((on: boolean) => void) | null = null;
    const set = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({
      onboarding: status,
      desktopAgent: {
        get: vi.fn().mockResolvedValue({ available: true, on: false, hidden: false }),
        set,
        onChanged: vi.fn((handler: (on: boolean) => void): (() => void) => {
          changed = handler;
          return () => undefined;
        }),
      },
    });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    const section = screen.getByRole('region', { name: 'Chat' });
    const toggle = await within(section).findByRole('switch', { name: 'Keep the agent button on the desktop' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith(true);
    act(() => changed?.(true));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('has no desktop button switch where the platform lacks it', async () => {
    const get = vi.fn().mockResolvedValue({ available: false, on: false, hidden: false });
    stubElectronAPI({ onboarding: status, desktopAgent: { get } });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    await act(async () => undefined);
    expect(get).toHaveBeenCalled();
    expect(screen.queryByRole('switch', { name: 'Keep the agent button on the desktop' })).toBeNull();
  });

  it('Show the agent button brings a hidden button back, and follows Hide button', async () => {
    let hiddenChanged: ((hidden: boolean) => void) | null = null;
    const setHidden = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({
      onboarding: status,
      desktopAgent: {
        get: vi.fn().mockResolvedValue({ available: true, on: true, hidden: true }),
        setHidden,
        onHiddenChanged: vi.fn((handler: (hidden: boolean) => void): (() => void) => {
          hiddenChanged = handler;
          return () => undefined;
        }),
      },
    });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    const show = await screen.findByRole('switch', { name: 'Show the agent button' });
    expect(show.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(show);
    expect(setHidden).toHaveBeenCalledWith(false);
    act(() => hiddenChanged?.(false));
    expect(show.getAttribute('aria-checked')).toBe('true');
  });

  it('has no Show the agent button switch while the desktop button is off', async () => {
    stubElectronAPI({ onboarding: status, desktopAgent: { get: vi.fn().mockResolvedValue({ available: true, on: false, hidden: true }) } });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    await screen.findByRole('switch', { name: 'Keep the agent button on the desktop' });
    expect(screen.queryByRole('switch', { name: 'Show the agent button' })).toBeNull();
    expect(screen.queryByText('Shortcut from any app')).toBeNull();
  });

  it('shows the shortcut from any app while the desktop button is on, with the one stored', async () => {
    stubElectronAPI({
      onboarding: status,
      desktopAgent: { get: vi.fn().mockResolvedValue({ available: true, on: true, hidden: false, shortcut: 'Control+Alt+B' }) },
    });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    expect(await screen.findByText('Shortcut from any app')).toBeTruthy();
    expect(await screen.findByText('⌃⌥B')).toBeTruthy();
  });
});

