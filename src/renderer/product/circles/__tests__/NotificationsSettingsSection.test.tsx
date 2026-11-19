import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { NotificationsSettingsSection } from '../NotificationsSettingsSection';

const notifyPrefs = vi.fn();
const setNotifyGlobal = vi.fn();
stubElectronAPI({
  circles: {
    notifyPrefs: (...args: unknown[]) => notifyPrefs(...args),
    setNotifyGlobal: (...args: unknown[]) => setNotifyGlobal(...args),
  },
});

beforeEach(() => {
  notifyPrefs.mockReset().mockResolvedValue({
    prefs: { level: 'default', channelMentions: true },
    resolved: 'all',
    people: 0,
    global: { enabled: true, showText: true },
  });
  setNotifyGlobal.mockReset().mockResolvedValue(undefined);
});

describe('NotificationsSettingsSection', () => {
  it('turns Circle notifications off and keeps the text setting', async () => {
    render(<NotificationsSettingsSection />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Circle notifications' }));
    expect(setNotifyGlobal).toHaveBeenCalledWith({ enabled: false, showText: true });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Circle notifications' }).getAttribute('aria-checked')).toBe('false'));
  });

  it('turns message text off and keeps the notifications setting', async () => {
    render(<NotificationsSettingsSection />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Show message text in notifications' }));
    expect(setNotifyGlobal).toHaveBeenCalledWith({ enabled: true, showText: false });
  });

  it('shows the hints', async () => {
    render(<NotificationsSettingsSection />);
    expect(await screen.findByText("Show a notification for Circle messages, following each Circle's setting.")).toBeTruthy();
    expect(screen.getByText('macOS keeps notifications in Notification Center and may show them on the lock screen.')).toBeTruthy();
  });
});
