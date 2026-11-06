import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddonDetail } from '../AddonDetail';
import { listing, stubAddons } from './addonFixtures';

afterEach(() => cleanup());

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
    expect(addons.install).toHaveBeenCalledWith('twenty');
    expect(started).toHaveBeenCalled();
  });

  it("detail disables Install and shows the resize text when memory doesn't fit", async () => {
    stubAddons([listing({ usedMiB: 10957 })]);
    renderDetail();
    expect(((await installButton()) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Needs 2.2 GB. The engine has 1.3 GB free.')).toBeTruthy();
    expect(
      screen.getByText(
        'Give the container engine 16 GB in its settings. This Mac has 32 GB, so 16 GB stays for macOS and your apps.'
      )
    ).toBeTruthy();
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

  it('turns Twenty off from Manage after confirming', async () => {
    const addons = stubAddons([listing({}, true)]);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn off Twenty CRM?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await vi.waitFor(() => expect(addons.turnOff).toHaveBeenCalledWith('twenty'));
  });

  it('remove needs the word delete', async () => {
    const addons = stubAddons([listing({}, true)]);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove and delete data' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Twenty CRM and delete its data?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete data' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const field = within(dialog).getByRole('textbox', { name: 'Type delete to confirm' });
    fireEvent.change(field, { target: { value: 'remove' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'delete' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(addons.removeData).toHaveBeenCalledWith('twenty'));
    expect(addons.turnOff).toHaveBeenCalledWith('twenty');
    expect(addons.turnOff.mock.invocationCallOrder[0]).toBeLessThan(
      addons.removeData.mock.invocationCallOrder[0]
    );
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
    expect(addons.removeData).not.toHaveBeenCalled();
  });

  it('says Turn off keeps the data', async () => {
    stubAddons([listing({}, true)]);
    renderDetail();
    expect(
      await screen.findByText(
        'Turning it off stops its containers and removes its tools from your agents. Its data stays on this Mac.'
      )
    ).toBeTruthy();
  });

  it('shows why removal failed', async () => {
    const addons = stubAddons([listing({}, true)]);
    addons.removeData.mockResolvedValue({ success: false, error: 'Remove its data from the stack checkout.' });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove and delete data' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete data' }));
    expect(await screen.findByText('Remove its data from the stack checkout.')).toBeTruthy();
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
