import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActualBudget, ActualOverview } from '../../../../shared/types/addons';
import { AddonDetail } from '../AddonDetail';
import { actualListing, stubAddons } from './addonFixtures';

// Actual's page against a fake main (spec decisions 20 and 22): the connect sheet's error paths,
// and Sign in again on a row whose session ended.

afterEach(() => cleanup());

const SERVER = 'https://budget.example.com';

function overviewWith(budgets: ActualBudget[], extra: Partial<ActualOverview> = {}): ActualOverview {
  return { enabled: true, local: false, localSetUp: false, budgets, statusError: null, ...extra };
}

const homeRow = (extra: Partial<ActualBudget> = {}): ActualBudget => ({
  slug: 'home',
  server: SERVER,
  local: false,
  syncId: 'home-1',
  access: 'write',
  state: 'ok',
  ...extra,
});

const fail = (error: string, message = '') => ({ success: true, result: { ok: false, error, message } });
const listed = (budgets: { syncId: string; name: string; encrypted: boolean }[]) => ({
  success: true,
  result: { ok: true, budgets },
});

function renderPage() {
  render(<AddonDetail id="actual" onBack={() => undefined} onInstallStarted={() => undefined} />);
}

async function openSheet() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect a budget' }));
  const dialog = await screen.findByRole('dialog');
  const field = (name: string | RegExp) => within(dialog).getByLabelText(name) as HTMLInputElement;
  const confirm = (name: RegExp | string) => within(dialog).getByRole('button', { name }) as HTMLButtonElement;
  return { dialog, field, confirm };
}

describe('ActualDetail connect sheet', () => {
  it('asks for the address and password, hidden and out of autofill, then lists the budgets', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([]) });
    addons.actual.serverBudgets.mockResolvedValueOnce(listed([{ syncId: 'home-1', name: 'Home', encrypted: false }]));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    expect(field('Server password').type).toBe('password');
    expect(field('Server password').getAttribute('autocomplete')).toBe('off');
    expect(confirm('Show budgets').disabled).toBe(true);
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.change(field('Server password'), { target: { value: 'pw' } });
    fireEvent.click(confirm('Show budgets'));
    expect(await within(dialog).findByRole('radio', { name: /Home/ })).toBeTruthy();
    expect(addons.actual.serverBudgets).toHaveBeenCalledWith({ server: SERVER, password: 'pw' });
    // The only budget is picked, its name becomes the slug, and Look things up is preselected.
    expect(field('Name agents use').value).toBe('home');
    expect((within(dialog).getByRole('radio', { name: /Look things up/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(confirm('Connect'));
    await vi.waitFor(() => expect(addons.actual.connect).toHaveBeenCalled());
    expect(addons.actual.connect).toHaveBeenCalledWith({
      server: SERVER,
      password: 'pw',
      slug: 'home',
      syncId: 'home-1',
      access: 'read',
      replace: false,
    });
  });

  it('says what a refused password means, and that nothing was saved', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([]) });
    addons.actual.serverBudgets.mockResolvedValueOnce(fail('login_refused', 'the server refused the password'));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.change(field('Server password'), { target: { value: 'wrong' } });
    fireEvent.click(confirm('Show budgets'));
    expect(await within(dialog).findByText('The server didn’t accept that password.')).toBeTruthy();
    expect(within(dialog).getByText('Nothing was saved.')).toBeTruthy();
  });

  it('names the host when the server can’t be reached', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([]) });
    addons.actual.serverBudgets.mockResolvedValueOnce(fail('server_unreachable'));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.change(field('Server password'), { target: { value: 'pw' } });
    fireEvent.click(confirm('Show budgets'));
    expect(
      await within(dialog).findByText('Couldn’t reach budget.example.com. Check the address and that the server is running.')
    ).toBeTruthy();
  });

  it('asks for the encryption password of an encrypted budget, and after encryption_password', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([]) });
    addons.actual.serverBudgets.mockResolvedValue(
      listed([
        { syncId: 'home-1', name: 'Home', encrypted: false },
        { syncId: 'vault-1', name: 'Vault', encrypted: true },
      ])
    );
    addons.actual.connect.mockResolvedValueOnce(fail('encryption_password'));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.change(field('Server password'), { target: { value: 'pw' } });
    fireEvent.click(confirm('Show budgets'));
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Vault/ }));
    expect(field('Encryption password').type).toBe('password');
    expect(confirm('Connect').disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Home/ }));
    expect(within(dialog).queryByLabelText('Encryption password')).toBeNull();
    // A budget the list didn't mark as encrypted, but connect says it is.
    fireEvent.click(confirm('Connect'));
    expect(await within(dialog).findByText('This budget is encrypted. Enter its encryption password.')).toBeTruthy();
    fireEvent.change(field('Encryption password'), { target: { value: 'enc' } });
    fireEvent.click(confirm('Connect'));
    await vi.waitFor(() => expect(addons.actual.connect).toHaveBeenCalledTimes(2));
    expect(addons.actual.connect.mock.calls[1]![0]).toMatchObject({ syncId: 'home-1', encryptionPassword: 'enc' });
  });

  it('offers Replace it after exists, and replaces on the next try', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([]) });
    addons.actual.serverBudgets.mockResolvedValue(listed([{ syncId: 'home-1', name: 'Home', encrypted: false }]));
    addons.actual.connect.mockResolvedValueOnce(fail('exists'));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.change(field('Server password'), { target: { value: 'pw' } });
    fireEvent.click(confirm('Show budgets'));
    await within(dialog).findByRole('radio', { name: /Home/ });
    fireEvent.click(confirm('Connect'));
    expect(
      await within(dialog).findByText('budget-home is already connected. Choose another name, or replace it.')
    ).toBeTruthy();
    expect(confirm('Connect').disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace it' }));
    fireEvent.click(confirm('Replace and connect'));
    await vi.waitFor(() => expect(addons.actual.connect).toHaveBeenCalledTimes(2));
    expect(addons.actual.connect.mock.calls[1]![0]).toMatchObject({ slug: 'home', replace: true });
  });

  it.each([
    ['timeout', 'The server didn’t answer within 45 seconds. Try again.'],
    ['no_access', 'This account can’t open that budget.'],
    ['bad_input', 'Couldn’t connect the budget (bad_input).'],
    ['command_failed', 'Couldn’t connect the budget (command_failed).'],
  ])('maps the connect error %s to its message', async (error, text) => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([]) });
    addons.actual.serverBudgets.mockResolvedValue(listed([{ syncId: 'home-1', name: 'Home', encrypted: false }]));
    addons.actual.connect.mockResolvedValueOnce(fail(error));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.change(field('Server password'), { target: { value: 'pw' } });
    fireEvent.click(confirm('Show budgets'));
    await within(dialog).findByRole('radio', { name: /Home/ });
    fireEvent.click(confirm('Connect'));
    expect(await within(dialog).findByText(text)).toBeTruthy();
  });

  it('takes a session token instead of the password', async () => {
    const addons = stubAddons([actualListing()]);
    addons.actual.serverBudgets.mockResolvedValueOnce(fail('token_expired'));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use a session token instead' }));
    expect(within(dialog).queryByLabelText('Server password')).toBeNull();
    fireEvent.change(field('Session token'), { target: { value: 'tok' } });
    fireEvent.click(confirm('Show budgets'));
    expect(await within(dialog).findByText('That session has ended. Sign in again.')).toBeTruthy();
    expect(addons.actual.serverBudgets).toHaveBeenCalledWith({ server: SERVER, sessionToken: 'tok' });
  });

  it('says where Actual keeps the session token, and that it isn’t a cookie', async () => {
    stubAddons([actualListing()]);
    renderPage();
    const { dialog } = await openSheet();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use a session token instead' }));
    expect(within(dialog).getByText(/IndexedDB → actual → asyncStorage copy the value of user-token\. It isn’t a cookie\./)).toBeTruthy();
  });

  it('runs the first budget as an install while Actual is off, and shows the steps at once', async () => {
    // Turning Actual on the first time takes minutes (log: enable 61 s, then connect 56 s).
    const addons = stubAddons([actualListing()]);
    addons.install.mockImplementation(() => new Promise(() => undefined));
    addons.actual.serverBudgets.mockResolvedValueOnce(listed([{ syncId: 'home-1', name: 'Home', encrypted: false }]));
    const onInstallStarted = vi.fn();
    render(<AddonDetail id="actual" onBack={() => undefined} onInstallStarted={onInstallStarted} />);
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Server address'), { target: { value: SERVER } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use a session token instead' }));
    fireEvent.change(field('Session token'), { target: { value: 'tok' } });
    fireEvent.click(confirm('Show budgets'));
    await within(dialog).findByRole('radio', { name: /Home/ });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Make changes/ }));
    fireEvent.click(confirm('Connect'));
    expect(onInstallStarted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(addons.install).toHaveBeenCalledWith('actual', {
      remote: { server: SERVER, sessionToken: 'tok', slug: 'home', syncId: 'home-1', access: 'write', replace: false },
    });
    expect(addons.actual.connect).not.toHaveBeenCalled();
  });
});

describe('ActualDetail rows', () => {
  it('shows an ended session on its row and signs in again with the row’s name, server and access', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([homeRow({ state: 'token_expired' })]) });
    addons.actual.serverBudgets.mockResolvedValueOnce(
      listed([
        { syncId: 'other-1', name: 'Other', encrypted: false },
        { syncId: 'home-1', name: 'Home', encrypted: false },
      ])
    );
    renderPage();
    const row = await screen.findByRole('listitem', { name: 'budget-home' });
    expect(within(row).getByText('That session has ended. Sign in again.')).toBeTruthy();
    expect(addons.actual.refresh).toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in again' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in again to budget-home' });
    const address = within(dialog).getByLabelText('Server address') as HTMLInputElement;
    expect(address.value).toBe(SERVER);
    expect(address.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Server password'), { target: { value: 'new-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show budgets' }));
    // The row's budget is picked from the list, and its name can't change.
    expect(((await within(dialog).findByRole('radio', { name: /Home/ })) as HTMLInputElement).checked).toBe(true);
    const name = within(dialog).getByLabelText('Name agents use') as HTMLInputElement;
    expect(name.value).toBe('home');
    expect(name.disabled).toBe(true);
    expect((within(dialog).getByRole('radio', { name: /Make changes/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace and connect' }));
    await vi.waitFor(() => expect(addons.actual.connect).toHaveBeenCalled());
    expect(addons.actual.connect).toHaveBeenCalledWith({
      server: SERVER,
      password: 'new-pw',
      slug: 'home',
      syncId: 'home-1',
      access: 'write',
      replace: true,
    });
  });

  it('says the old connection is gone when Sign in again fails', async () => {
    const addons = stubAddons([actualListing()], { actual: overviewWith([homeRow({ state: 'token_expired' })]) });
    addons.actual.serverBudgets.mockResolvedValueOnce(listed([{ syncId: 'home-1', name: 'Home', encrypted: false }]));
    addons.actual.connect.mockResolvedValueOnce(fail('login_refused'));
    renderPage();
    const row = await screen.findByRole('listitem', { name: 'budget-home' });
    fireEvent.click(within(row).getByRole('button', { name: 'Sign in again' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Server password'), { target: { value: 'pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show budgets' }));
    await within(dialog).findByRole('radio', { name: /Home/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace and connect' }));
    expect(await within(dialog).findByText('The server didn’t accept that password.')).toBeTruthy();
    expect(within(dialog).getByText('The old connection was removed, and nothing new was saved.')).toBeTruthy();
  });

  it.each([
    [
      'with another server’s budget, the add-on stays on and agents keep the local entry',
      [homeRow({ slug: 'mac', server: 'local', local: true }), homeRow()],
      'The server stops. Agents still see budget-mac, but its tools fail until you turn the server on again. budget-home stays connected. Its budgets stay on this Mac.',
    ],
    [
      'with only this Mac’s budgets, the add-on turns off',
      [homeRow({ slug: 'mac', server: 'local', local: true })],
      'The server stops. budget-mac can’t be used until you turn it on again. Its budgets stay on this Mac.',
    ],
  ])('says what Turn off does %s', async (_case, budgets, text) => {
    stubAddons([actualListing(true)], { actual: overviewWith(budgets, { local: true, localSetUp: true }) });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(text)).toBeTruthy();
  });

  it('offers no Sign in again on a working row', async () => {
    stubAddons([actualListing()], { actual: overviewWith([homeRow()]) });
    renderPage();
    const row = await screen.findByRole('listitem', { name: 'budget-home' });
    expect(within(row).queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });
});
