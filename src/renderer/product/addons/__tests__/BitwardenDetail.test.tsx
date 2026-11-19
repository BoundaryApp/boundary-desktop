import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BitwardenAccount, BitwardenOverview } from '../../../../shared/types/addons';
import { AddonDetail } from '../AddonDetail';
import { AddonAttentionDot, AddonStoppedAlerts } from '../AddonStoppedAlert';
import { bitwardenListing, stubAddons } from './addonFixtures';

// Bitwarden's page against a fake main (spec decisions 27–30): the connect sheet, a wrong
// master password at Unlock, and a request that clears after Check now.

vi.mock('../../assistantStack', () => ({ useAssistantStackLifecycle: () => ({ phase: 'ready' }) }));

afterEach(() => cleanup());

const account = (extra: Partial<BitwardenAccount> = {}): BitwardenAccount => ({
  slug: 'home',
  mode: 'cloud',
  scope: 'folder:Agent',
  unlock: 'manual',
  state: 'locked',
  error: null,
  retryAfter: null,
  file: null,
  canDisconnect: true,
  ...extra,
});

function overviewWith(extra: Partial<BitwardenOverview> = {}): BitwardenOverview {
  return { enabled: true, accounts: [], requests: [], statusError: null, requestsError: null, ...extra };
}

const fail = (error: string, extra: Record<string, unknown> = {}) => ({ success: true, result: { ok: false, error, message: '', ...extra } });

function renderPage() {
  render(<AddonDetail id="bitwarden" onBack={() => undefined} onInstallStarted={() => undefined} />);
}

async function openSheet() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect an account' }));
  const dialog = await screen.findByRole('dialog');
  const field = (name: string | RegExp) => within(dialog).getByLabelText(name) as HTMLInputElement;
  const confirm = () => within(dialog).getByRole('button', { name: /Connect$/ }) as HTMLButtonElement;
  return { dialog, field, confirm };
}

describe('BitwardenDetail connect sheet', () => {
  it('asks for the server, the API key hidden, a folder and Ask me each time, and sends them once', async () => {
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith() });
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    expect((within(dialog).getByRole('radio', { name: 'bitwarden.com (US)' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('radio', { name: /Ask me each time/ }) as HTMLInputElement).checked).toBe(true);
    expect(field('client_secret').type).toBe('password');
    expect(field('client_secret').getAttribute('autocomplete')).toBe('off');
    expect(field('Folder').value).toBe('Agent');
    expect(within(dialog).queryByLabelText('Master password')).toBeNull();
    expect(confirm().disabled).toBe(true);

    fireEvent.change(field('Account name'), { target: { value: 'local' } });
    expect(within(dialog).getByText('local is the stack’s own account. Choose another name.')).toBeTruthy();
    fireEvent.change(field('Account name'), { target: { value: 'home' } });
    fireEvent.change(field('client_id'), { target: { value: 'user.synthetic' } });
    fireEvent.change(field('client_secret'), { target: { value: 'secret-synthetic' } });
    expect(confirm().disabled).toBe(false);

    // Keep me unlocked needs the master password before it can send.
    fireEvent.click(within(dialog).getByRole('radio', { name: /Keep me unlocked/ }));
    expect(field('Master password').type).toBe('password');
    expect(confirm().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Ask me each time/ }));

    fireEvent.click(confirm());
    await vi.waitFor(() => expect(addons.bitwarden.connect).toHaveBeenCalledTimes(1));
    expect(addons.bitwarden.connect).toHaveBeenCalledWith({
      slug: 'home',
      server: { kind: 'us' },
      scope: 'folder:Agent',
      unlock: 'manual',
      clientId: 'user.synthetic',
      clientSecret: 'secret-synthetic',
      replace: false,
    });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends a self-hosted address and an organization collection from Advanced', async () => {
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith() });
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Your own server' }));
    fireEvent.change(field('Server address'), { target: { value: 'http://vault.example.com' } });
    expect(within(dialog).getByText('Use the server’s https:// address.')).toBeTruthy();
    fireEvent.change(field('Server address'), { target: { value: 'https://vault.example.com/' } });
    fireEvent.change(field('Account name'), { target: { value: 'work' } });
    fireEvent.change(field('client_id'), { target: { value: 'id' } });
    fireEvent.change(field('client_secret'), { target: { value: 'secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Advanced/ }));
    fireEvent.change(field('Organization collection ID'), { target: { value: 'c0ffee-42' } });
    expect(within(dialog).queryByLabelText('Folder')).toBeNull();
    fireEvent.click(confirm());
    await vi.waitFor(() => expect(addons.bitwarden.connect).toHaveBeenCalled());
    expect(addons.bitwarden.connect.mock.calls[0]![0]).toMatchObject({
      server: { kind: 'selfhosted', url: 'https://vault.example.com' },
      scope: 'collection:c0ffee-42',
    });
  });

  it.each([
    ['login_refused', {}, 'Bitwarden didn’t accept that API key or master password.'],
    ['rate_limited', { retryAfter: 40 }, 'Bitwarden is limiting sign-ins. Try again in 40 seconds.'],
    ['rate_limited', {}, 'Bitwarden is limiting sign-ins. Try again in a minute.'],
    ['server_unreachable', {}, 'Couldn’t reach vault.bitwarden.com. Check the address and that the server is running.'],
    ['timeout', {}, 'Bitwarden didn’t finish signing in. Try again.'],
    ['broker_down', {}, 'Bitwarden isn’t running. Turn it on again, or restart the assistant.'],
    ['bad_input', {}, 'Couldn’t connect the account (bad_input).'],
    ['exists', {}, 'An account named home is already connected. Choose another name, or replace it.'],
  ])('says what %s means, and that nothing was saved', async (error, extra, text) => {
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith() });
    addons.bitwarden.connect.mockResolvedValueOnce(fail(error, extra));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Account name'), { target: { value: 'home' } });
    fireEvent.change(field('client_id'), { target: { value: 'id' } });
    fireEvent.change(field('client_secret'), { target: { value: 'secret' } });
    fireEvent.click(confirm());
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(within(dialog).getByText('Nothing was saved.')).toBeTruthy();
    if (error === 'exists') expect(within(dialog).getByRole('button', { name: 'Replace it' })).toBeTruthy();
  });

  it('replaces an existing account and says the old one stays when the new key fails', async () => {
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith() });
    addons.bitwarden.connect.mockResolvedValueOnce(fail('exists')).mockResolvedValueOnce(fail('login_refused'));
    renderPage();
    const { dialog, field, confirm } = await openSheet();
    fireEvent.change(field('Account name'), { target: { value: 'home' } });
    fireEvent.change(field('client_id'), { target: { value: 'id' } });
    fireEvent.change(field('client_secret'), { target: { value: 'secret' } });
    fireEvent.click(confirm());
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Replace it' }));
    expect(within(dialog).getByText(/It stays connected until the new key signs in\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace and connect' }));
    expect(await within(dialog).findByText('The old home stays connected, and nothing new was saved.')).toBeTruthy();
    expect(addons.bitwarden.connect.mock.calls[1]![0]).toMatchObject({ slug: 'home', replace: true });
  });

  it('warns that connecting locks the other unlocked manual accounts', async () => {
    stubAddons([bitwardenListing(true)], { bitwarden: overviewWith({ accounts: [account({ slug: 'work', state: 'unlocked' })] }) });
    renderPage();
    const { dialog } = await openSheet();
    expect(within(dialog).getByText(/Connecting restarts Bitwarden, which locks work/)).toBeTruthy();
  });
});

describe('BitwardenDetail unlock', () => {
  it('keeps the account locked with a message after a wrong master password, then unlocks with the right one', async () => {
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith({ accounts: [account()] }) });
    addons.bitwarden.unlock.mockResolvedValueOnce(fail('login_refused'));
    renderPage();
    const row = await screen.findByRole('listitem', { name: 'home' });
    expect(within(row).getByText('Locked')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Unlock' }));
    const dialog = await screen.findByRole('dialog');
    const password = within(dialog).getByLabelText('Master password') as HTMLInputElement;
    expect(password.type).toBe('password');
    fireEvent.change(password, { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(await within(dialog).findByText('That master password didn’t unlock the account. It’s still locked.')).toBeTruthy();
    // One try per press: the field is cleared, and Unlock waits for a new password.
    expect(password.value).toBe('');
    expect((within(dialog).getByRole('button', { name: 'Unlock' }) as HTMLButtonElement).disabled).toBe(true);
    expect(addons.bitwarden.unlock).toHaveBeenCalledTimes(1);
    fireEvent.change(password, { target: { value: 'right' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(addons.bitwarden.unlock).toHaveBeenLastCalledWith('home', 'right');
  });

  it('lists locked accounts on the unlock card after a restart, and shows the Services dot', async () => {
    stubAddons([bitwardenListing(true)], {
      bitwarden: overviewWith({ accounts: [account(), account({ slug: 'kept', unlock: 'stored', state: 'unlocked' })] }),
    });
    render(
      <>
        <AddonStoppedAlerts />
        <AddonAttentionDot />
      </>
    );
    const card = await screen.findByRole('alert');
    expect(within(card).getByRole('button', { name: 'Unlock home' })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Unlock kept' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Bitwarden needs you' })).toBeTruthy();
  });

  it('shows terminal accounts without controls, and says why there’s no Disconnect', async () => {
    stubAddons([bitwardenListing(true)], {
      bitwarden: overviewWith({
        accounts: [account({ slug: 'local', mode: 'local', canDisconnect: false }), account({ slug: 'old', canDisconnect: false })],
      }),
    });
    renderPage();
    const local = await screen.findByRole('listitem', { name: 'local' });
    expect(within(local).queryByRole('button')).toBeNull();
    const old = screen.getByRole('listitem', { name: 'old' });
    expect(within(old).queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(within(old).getByText(/Disconnect works after the next make up/)).toBeTruthy();
  });
});

describe('BitwardenDetail refused accounts', () => {
  const preUpdate = account({ mode: null, scope: null, unlock: null, state: 'refused', error: 'missing_client_id', file: 'home.json' });

  it('offers Connect again on an account connected before the update, which opens the sheet on it with replace on', async () => {
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith({ accounts: [preUpdate] }) });
    addons.bitwarden.connect.mockResolvedValueOnce(fail('login_refused')).mockResolvedValueOnce({ success: true, result: { ok: true, message: '' } });
    renderPage();
    const row = await screen.findByRole('listitem', { name: 'home' });
    expect(within(row).getByText('Refused')).toBeTruthy();
    expect(within(row).getByText(/Connect this account again with its API key\./)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Connect again' }));

    const dialog = await screen.findByRole('dialog', { name: 'Connect home again' });
    const field = (name: string) => within(dialog).getByLabelText(name) as HTMLInputElement;
    expect(field('Account name').value).toBe('home');
    expect(within(dialog).getByText(/Connecting replaces the old home/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Replace it' })).toBeNull();
    fireEvent.change(field('client_id'), { target: { value: 'id' } });
    fireEvent.change(field('client_secret'), { target: { value: 'secret' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(dialog).findByText('home still needs connecting again. Nothing new was saved.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(addons.bitwarden.connect.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ slug: 'home', replace: true }),
      expect.objectContaining({ slug: 'home', replace: true }),
    ]);

    // Connect an account afterwards opens an empty sheet, not the mended account.
    fireEvent.click(screen.getByRole('button', { name: 'Connect an account' }));
    const fresh = await screen.findByRole('dialog', { name: 'Connect a Bitwarden account' });
    expect((within(fresh).getByLabelText('Account name') as HTMLInputElement).value).toBe('');
  });

  it('says a file with a bad name can only be removed at the terminal, with no buttons', async () => {
    stubAddons([bitwardenListing(true)], {
      bitwarden: overviewWith({
        accounts: [account({ slug: null, mode: null, scope: null, unlock: null, state: 'refused', error: 'bad_slug', file: 'Bad Name.json', canDisconnect: false })],
      }),
    });
    renderPage();
    const row = await screen.findByRole('listitem', { name: 'Bad Name.json' });
    expect(within(row).getByText('The account file Bad Name.json has a name the stack can’t use. Remove it at the terminal.')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
  });
});

describe('BitwardenDetail requests', () => {
  it('lists a request with the agent’s words, and clears it after Check now', async () => {
    const request = { requestId: 'a1b2', account: 'home', site: 'example.com', reason: 'to download the bill', created: 1_800_000_000 };
    const addons = stubAddons([bitwardenListing(true)], {
      bitwarden: overviewWith({ accounts: [account({ state: 'unlocked' })], requests: [request] }),
    });
    addons.bitwarden.sync.mockImplementationOnce(async () => {
      // Main reads the requests again after the sync and sends the new overview.
      addons.emitBitwarden(overviewWith({ accounts: [account({ state: 'unlocked' })] }));
      return { success: true, result: { ok: true, synced: ['home'], recent: false } };
    });
    renderPage();
    const item = await screen.findByRole('listitem', { name: 'Request for example.com' });
    expect(within(item).getByText('to download the bill')).toBeTruthy();
    expect(within(item).getByText(/move the login for example.com into the Agent folder/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await vi.waitFor(() => expect(screen.queryByRole('listitem', { name: 'Request for example.com' })).toBeNull());
    expect(addons.bitwarden.sync).toHaveBeenCalledTimes(1);
  });

  it('says to try again while another check runs, and that a check within 30 seconds shows the last result', async () => {
    const request = { requestId: 'a1b2', account: 'home', site: 'example.com', reason: '', created: 1 };
    const addons = stubAddons([bitwardenListing(true)], { bitwarden: overviewWith({ accounts: [account()], requests: [request] }) });
    addons.bitwarden.sync.mockResolvedValueOnce(fail('busy'));
    addons.bitwarden.sync.mockResolvedValueOnce({ success: true, result: { ok: true, synced: ['home'], recent: true } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Bitwarden is already checking. Try again in a moment.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Bitwarden checked less than 30 seconds ago, so this is that check’s result.')).toBeTruthy();
  });

});
