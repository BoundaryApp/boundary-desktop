import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CalendarsPanel } from '../CalendarsPanel';
import { setStackCapabilitiesForTests } from '../stackCapabilities';
import { calendarsApi, macAccount, macCalendars, openMacAllow, openSignIn, stubCalendars, urlsApi } from './calendarsHarness';

describe('CalendarsPanel', () => {
  beforeEach(stubCalendars);

  it('lists Calendars on this Mac first and routes Google and Microsoft 365 to it', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'notDetermined', calendars: [] });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    const radios = screen.getAllByRole('radio');
    const firstCard = radios[0].closest('label')?.textContent;
    expect(firstCard).toContain('Calendars on this Mac');
    expect(firstCard).toContain('No password. iCloud, Google, Microsoft 365 and other accounts in System Settings');
    expect(screen.getByText('Needs an app-specific password, or use Calendars on this Mac')).toBeTruthy();
    const google = screen.getByRole('button', { name: /Google Calendar/ });
    expect(google.textContent).toContain('Use Calendars on this Mac');
    fireEvent.click(google);
    expect((screen.getByRole('radio', { name: /^Calendars on this Mac/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Outlook and Microsoft 365/ }));
    expect((screen.getByRole('radio', { name: /^Calendars on this Mac/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('asks macOS for access, then shows the calendars grouped by account with defaults ticked', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'notDetermined', calendars: [] });
    calendarsApi.macRequestAccess.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    calendarsApi.macConnect.mockResolvedValue({ success: true, account: macAccount });
    await openMacAllow();
    expect(await screen.findByText('Agents you choose will see the events in the calendars you tick.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Allow calendar access' }));
    expect(await screen.findByRole('group', { name: 'iCloud' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Work Exchange' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Home/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Team/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Birthdays/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: /Moon phases/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getAllByText('Read only').length).toBe(2);

    fireEvent.click(screen.getByRole('checkbox', { name: /Birthdays/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Who can use This Mac?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(calendarsApi.macConnect).toHaveBeenCalledWith({
        allowedCalendarIds: ['c1', 'c2', 'c3'],
        access: { assistant: 'change', researcher: 'off' },
      })
    );
    expect(await screen.findByText(/This Mac connected/)).toBeTruthy();
  });

  it('shows Open Privacy Settings when access was denied, and re-checks on window focus', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'denied', calendars: [] });
    await openMacAllow();
    expect(await screen.findByText(/macOS won’t ask again\. Turn on .* under Calendars in Privacy & Security\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Privacy Settings' }));
    expect(calendarsApi.openPrivacySettings).toHaveBeenCalledWith();
    expect(urlsApi.openUrl).not.toHaveBeenCalled();

    calendarsApi.openPrivacySettings.mockRejectedValue(new Error('no'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Privacy Settings' }));
    expect(await screen.findByText('Couldn’t open System Settings.')).toBeTruthy();

    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await screen.findByRole('group', { name: 'iCloud' })).toBeTruthy();
  });

  it('says so when the calendar helper is missing', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'missing', calendars: [] });
    await openMacAllow();
    expect(await screen.findByText(/calendar helper is missing from this build\./)).toBeTruthy();
  });

  it('shows an error line instead of an unhandled rejection when the helper times out', async () => {
    calendarsApi.macStatus.mockRejectedValue(new Error('timeout'));
    await openMacAllow();
    expect(await screen.findByText(/Couldn’t check calendar access/)).toBeTruthy();
    calendarsApi.macStatus.mockResolvedValue({ access: 'notDetermined', calendars: [] });
    calendarsApi.macRequestAccess.mockRejectedValue(new Error('timeout'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow calendar access' }));
    expect(await screen.findByText(/Couldn’t ask for calendar access/)).toBeTruthy();
  });

  it('disables Continue when no calendar is ticked', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    await openMacAllow();
    await screen.findByRole('group', { name: 'iCloud' });
    const next = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: /Home/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Team/ }));
    expect(next.disabled).toBe(true);
  });

  it('stops listening for window focus when the sheet closes', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'denied', calendars: [] });
    await openMacAllow();
    await screen.findByText(/macOS won’t ask again/);
    fireEvent.keyDown(document.body, { key: 'Escape', bubbles: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    calendarsApi.macStatus.mockClear();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(calendarsApi.macStatus).not.toHaveBeenCalled();
  });

  it('shows one This Mac card with Edit calendars and the works-while-open line', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [macAccount] });
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars, dropped: ['Old shared'] });
    calendarsApi.macSetCalendars.mockResolvedValue({ success: true, account: macAccount });
    render(<CalendarsPanel />);
    const card = await screen.findByRole('article', { name: 'This Mac' });
    expect(await within(card).findByText('Team')).toBeTruthy();
    expect(within(card).getByText('Home')).toBeTruthy();
    expect(within(card).queryByText('Moon phases')).toBeNull();
    expect(within(card).getByText(/Old shared/)).toBeTruthy();
    expect(within(card).getByText(/Works while .* is open\./)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Replace password' })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Edit calendars' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('group', { name: 'iCloud' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Moon phases/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calendarsApi.macSetCalendars).toHaveBeenCalledWith({ allowedCalendarIds: ['c1', 'c3', 'c4'] }));
  });

  it('re-checks status when the window regains focus and turns the card red with Open Privacy Settings on denied', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [macAccount] });
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    render(<CalendarsPanel />);
    const card = await screen.findByRole('article', { name: 'This Mac' });
    expect(await within(card).findByText('Team')).toBeTruthy();
    expect(within(card).getByText('Connected')).toBeTruthy();
    expect(within(card).queryByRole('alert')).toBeNull();

    calendarsApi.macStatus.mockResolvedValue({ access: 'denied', calendars: [] });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toMatch(/Calendar access was turned off in System Settings\. Agents can’t use This Mac until you turn .* back on/);
    // Red: the destructive callout, not the amber warning.
    expect(alert.className).toContain('bg-danger-dim');
    expect(within(card).getByText('Access off').className).toContain('is-bad');
    fireEvent.click(within(alert).getByRole('button', { name: 'Open Privacy Settings' }));
    expect(calendarsApi.openPrivacySettings).toHaveBeenCalledWith();

    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(within(card).queryByRole('alert')).toBeNull());
    expect(within(card).getByText('Connected')).toBeTruthy();
  });

  it('shows Restart when the helper stopped, and restarts it', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [macAccount] });
    calendarsApi.macStatus.mockResolvedValue({ access: 'stopped', calendars: [] });
    let finish: (status: unknown) => void = () => undefined;
    calendarsApi.macRestartHelper.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<CalendarsPanel />);
    const card = await screen.findByRole('article', { name: 'This Mac' });
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toContain('The calendar helper stopped.');
    expect(within(card).getByText('Helper stopped').className).toContain('is-bad');

    fireEvent.click(within(alert).getByRole('button', { name: 'Restart' }));
    expect(calendarsApi.macRestartHelper).toHaveBeenCalledWith();
    expect((within(alert).getByRole('button', { name: 'Restarting…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ access: 'granted', calendars: macCalendars }));
    await waitFor(() => expect(within(card).queryByRole('alert')).toBeNull());
    expect(within(card).getByText('Team')).toBeTruthy();

    // A restart that fails says so and keeps the button.
    calendarsApi.macStatus.mockResolvedValue({ access: 'stopped', calendars: [] });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    const again = await within(card).findByRole('alert');
    calendarsApi.macRestartHelper.mockRejectedValue(new Error('no'));
    fireEvent.click(within(again).getByRole('button', { name: 'Restart' }));
    expect(await within(card).findByText('Couldn’t restart the calendar helper.')).toBeTruthy();
    expect(within(again).getByRole('button', { name: 'Restart' })).toBeTruthy();
  });

  it('hides Calendars on this Mac from the provider list once a Mac account exists', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [macAccount] });
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect another calendar' }));
    expect(screen.queryByRole('radio', { name: /^Calendars on this Mac/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Google Calendar/ })).toBeNull();
    expect(screen.getByText('Needs an app-specific password')).toBeTruthy();
  });

  it('switches the sheet to Calendars on this Mac from the walkthrough line', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'notDetermined', calendars: [] });
    await openSignIn();
    fireEvent.click(screen.getByRole('button', { name: 'Show me how' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rather not make a password? Use Calendars on this Mac' }));
    expect(await screen.findByRole('button', { name: 'Allow calendar access' })).toBeTruthy();
  });

  it('says no calendars were found when access is granted but the list is empty', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: [] });
    await openMacAllow();
    expect(await screen.findByText('No calendars found on this Mac.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the error and stays on the access step when macConnect rejects', async () => {
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    calendarsApi.macConnect.mockRejectedValue(new Error('helper timeout'));
    await openMacAllow();
    await screen.findByRole('group', { name: 'iCloud' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calendarsApi.macConnect).toHaveBeenCalled());
    expect(await screen.findByText('Who can use This Mac?')).toBeTruthy();
    expect(await screen.findByText(/helper timeout|Couldn’t connect/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the error and keeps Edit calendars open when macSetCalendars rejects', async () => {
    calendarsApi.list.mockResolvedValue({ success: true, accounts: [macAccount] });
    calendarsApi.macStatus.mockResolvedValue({ access: 'granted', calendars: macCalendars });
    calendarsApi.macSetCalendars.mockRejectedValue(new Error('helper timeout'));
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit calendars' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('group', { name: 'iCloud' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calendarsApi.macSetCalendars).toHaveBeenCalled());
    expect(await within(dialog).findByText(/helper timeout|Couldn’t save/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('offers no Calendars on this Mac, and says why, on a host without hostCallbacks', async () => {
    setStackCapabilitiesForTests({ hostCallbacks: false });
    render(<CalendarsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Connect calendar/ }));
    expect(screen.queryByRole('radio', { name: /^Calendars on this Mac/ })).toBeNull();
    expect(screen.getByText("Your agent runs on another computer, so it can't reach apps and services on this one.")).toBeTruthy();
    expect(screen.queryByText('Use Calendars on this Mac')).toBeNull();
  });
});
