import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AddonDetail } from '../AddonDetail';
import { hostedWorkspace, listing, stubAddons } from './addonFixtures';

function renderDetail(onInstallStarted = vi.fn()) {
  render(<AddonDetail id="twenty" onBack={() => undefined} onInstallStarted={onInstallStarted} />);
  return onInstallStarted;
}

const installButton = () => screen.findByRole('button', { name: 'Install' });

describe('AddonDetail', () => {
  it('starts the install from Install when Twenty fits', async () => {
    const addons = stubAddons([listing()]);
    const started = renderDetail();
    expect(await screen.findByText('Yes.')).toBeTruthy();
    expect(screen.getByText('Opens on this Mac only, at localhost:3000. Nothing is reachable from your network.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What it runs' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What your agents get' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeTruthy();
    fireEvent.click(await installButton());
    expect(addons.install).toHaveBeenCalledWith('twenty', { access: 'write' });
    expect(started).toHaveBeenCalled();
  });

  it("offers Make room and install when memory doesn't fit and the engine can grow", async () => {
    const addons = stubAddons([listing({ usedMiB: 10957 })]);
    const started = renderDetail();
    expect(await screen.findByText('Needs 2.2 GB. The engine has 1.3 GB free.')).toBeTruthy();
    expect(
      screen.getByText(
        'Installing gives the container engine 14 GB first. Your assistant pauses for about two minutes while the engine restarts. This Mac has 32 GB, so 18 GB stays for macOS and your apps.'
      )
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Make room and install' }));
    await vi.waitFor(() => expect(addons.install).toHaveBeenCalledWith('twenty', { access: 'write', makeRoom: true }));
    expect(started).toHaveBeenCalled();
  });

  it('waits for running agent work before making room, and can stop waiting', async () => {
    const addons = stubAddons([listing({ usedMiB: 10957 })], {
      work: [{ id: 'c1', kind: 'chat', title: 'A chat', detail: 'Replying' }],
    });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Make room and install' }));
    expect(
      await screen.findByText(
        'Agent work is running. Twenty CRM installs when it finishes, after the container engine restarts.'
      )
    ).toBeTruthy();
    expect(addons.install).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Make room and install' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Don’t wait' }));
    expect((screen.getByRole('button', { name: 'Make room and install' }) as HTMLButtonElement).disabled).toBe(false);
    expect(addons.install).not.toHaveBeenCalled();
  });

  it("disables Install when memory doesn't fit and the engine can't grow", async () => {
    stubAddons([listing({ usedMiB: 10957, engineResizable: false })]);
    renderDetail();
    expect(((await installButton()) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Turn off another add-on to free memory for this one.')).toBeTruthy();
    expect(screen.getAllByText('Needs more memory').length).toBeGreaterThan(0);
  });

  it('shows the port-in-use check', async () => {
    stubAddons([listing({ portInUse: true })]);
    renderDetail();
    expect(((await installButton()) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('Something on this Mac already uses port 3000. Stop it, then check again.')
    ).toBeTruthy();
    expect(screen.getAllByText('Port in use').length).toBeGreaterThan(0);
  });

  it('asks for the agent stack in place of the fit checks while the engine is down', async () => {
    stubAddons([listing({ engineMiB: 0, usedMiB: 0 })]);
    renderDetail();
    expect(await screen.findByText('Start the agent stack to check whether this fits.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Will it fit on this Mac?' })).toBeNull();
    expect(((await installButton()) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Start and Mark as not installed while installed Twenty is not running', async () => {
    const addons = stubAddons([listing({}, true, true, false, true)]);
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Twenty CRM isn’t running' })).toBeTruthy();
    expect(screen.getAllByText('Not running').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'This Mac’s Twenty' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start Twenty CRM' }));
    expect(addons.start).toHaveBeenCalledWith('twenty');
  });

  it('shows no stopped callout while installed Twenty runs', async () => {
    stubAddons([listing({}, true)]);
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'This Mac’s Twenty' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Twenty CRM isn’t running' })).toBeNull();
  });

  it('turns Twenty off from Manage after confirming', async () => {
    const addons = stubAddons([listing({}, true)]);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn off this Mac’s Twenty?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await vi.waitFor(() => expect(addons.turnOff).toHaveBeenCalledWith('twenty'));
  });

  it('remove needs the word delete, defaults to deleting images, and closes at once into the progress view', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [hostedWorkspace('work')] });
    const started = renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove and delete data' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this Mac’s Twenty and delete its data?' });
    expect(within(dialog).getByText(/crm-work stays connected\./)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Remove and delete data' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const field = within(dialog).getByRole('textbox', { name: 'Type delete to confirm' });
    fireEvent.change(field, { target: { value: 'remove' } });
    expect(confirm.disabled).toBe(true);
    const images = within(dialog).getByRole('checkbox', { name: /Also delete the downloaded images/ }) as HTMLInputElement;
    expect(images.checked).toBe(true);
    expect(within(dialog).getByText('Frees about 1.1 GB. Installing again downloads them again.')).toBeTruthy();
    fireEvent.change(field, { target: { value: 'delete' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(started).toHaveBeenCalled();
    await vi.waitFor(() => expect(addons.remove).toHaveBeenCalledWith('twenty', { deleteImages: true }));
    expect(addons.turnOff).not.toHaveBeenCalled();
  });

  it('keeps the images when the box is cleared', async () => {
    const addons = stubAddons([listing({}, true)]);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove and delete data' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Also delete the downloaded images/ }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove and delete data' }));
    await vi.waitFor(() => expect(addons.remove).toHaveBeenCalledWith('twenty', { deleteImages: false }));
  });

  it('disables Remove in a local stack and never turns the add-on off for it', async () => {
    const addons = stubAddons([listing({}, true, false)]);
    renderDetail();
    const remove = (await screen.findByRole('button', {
      name: 'Remove and delete data',
    })) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(
      screen.getByText(
        "Remove Twenty's data from the stack checkout instead; Boundary doesn't delete files in a local stack."
      )
    ).toBeTruthy();
    fireEvent.click(remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(addons.turnOff).not.toHaveBeenCalled();
    expect(addons.remove).not.toHaveBeenCalled();
  });

  it('says Turn off keeps the data', async () => {
    stubAddons([listing({}, true)]);
    renderDetail();
    expect(
      await screen.findByText(
        'Turning it off stops its containers, and agents lose crm-main after the next assistant restart. Its data stays, so turning it on again picks up where you left off.'
      )
    ).toBeTruthy();
  });

  it('a refused removal shows as a failed first step in the progress view', async () => {
    const addons = stubAddons([listing({}, true)]);
    addons.remove.mockResolvedValue({ success: false, error: 'Remove its data from the stack checkout.' });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove and delete data' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove and delete data' }));
    expect(await screen.findAllByText('Removal failed')).toBeTruthy();
  });

  it('opens the connect sheet from the page', async () => {
    stubAddons([listing()]);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a workspace' }));
    expect(screen.getByRole('dialog', { name: 'Connect a hosted Twenty workspace' })).toBeTruthy();
    expect(screen.queryByText(/isn’t in this build yet/)).toBeNull();
  });

  describe('after an install that did not finish', () => {
    const leftover = () => listing({}, false, true, true);

    it('offers Try again and Remove leftover containers in place of Install', async () => {
      stubAddons([leftover()]);
      renderDetail();
      expect(await screen.findByRole('heading', { name: 'Install didn’t finish' })).toBeTruthy();
      expect(
        screen.getByText(
          'Twenty CRM’s containers are still running from an install that didn’t finish. They reserve engine memory and start again when the container engine restarts. Its data and downloads stay on this Mac either way.'
        )
      ).toBeTruthy();
      expect(screen.getAllByText('Install didn’t finish').length).toBeGreaterThan(1);
      expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Remove leftover containers' })).toBeTruthy();
    });

    it('Try again starts the install', async () => {
      const addons = stubAddons([leftover()]);
      const started = renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
      expect(addons.install).toHaveBeenCalledWith('twenty');
      expect(started).toHaveBeenCalled();
    });

    it('Remove leftover containers runs undo and reads the list again', async () => {
      const addons = stubAddons([leftover()]);
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Remove leftover containers' }));
      await vi.waitFor(() => expect(addons.undo).toHaveBeenCalledWith('twenty'));
      await vi.waitFor(() => expect(addons.list.mock.calls.length).toBeGreaterThan(1));
      expect(addons.install).not.toHaveBeenCalled();
    });

    it('shows why removing the leftover containers failed', async () => {
      const addons = stubAddons([leftover()]);
      addons.undo.mockResolvedValue({ success: false, error: 'docker is not running' });
      renderDetail();
      fireEvent.click(await screen.findByRole('button', { name: 'Remove leftover containers' }));
      expect(await screen.findByText('docker is not running')).toBeTruthy();
    });
  });
});
