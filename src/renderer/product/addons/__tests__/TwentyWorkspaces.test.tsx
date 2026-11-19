import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddonDetail } from '../AddonDetail';
import { codingTask, hostedWorkspace, listing, localWorkspace, stubAddons } from './addonFixtures';

afterEach(() => {
  // Unmount while fake timers are installed; RTL's own cleanup runs after this hook.
  cleanup();
  vi.useRealTimers();
});

function renderDetail(onInstallStarted = vi.fn()) {
  render(<AddonDetail id="twenty" onBack={() => undefined} onInstallStarted={onInstallStarted} />);
  return onInstallStarted;
}

describe('Twenty page with nothing set up', () => {
  it('offers two ways in and no third access choice', async () => {
    const addons = stubAddons([listing()]);
    const started = renderDetail();
    expect(await screen.findByRole('heading', { name: 'Run it on this Mac' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connect one you already use' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Look things up/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Make changes/ })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Connect a workspace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(addons.install).toHaveBeenCalledWith('twenty', { access: 'write' });
    expect(started).toHaveBeenCalled();
  });

  it('passes the chosen access to the install', async () => {
    const addons = stubAddons([listing()]);
    renderDetail();
    fireEvent.click(await screen.findByRole('radio', { name: /Look things up/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(addons.install).toHaveBeenCalledWith('twenty', { access: 'read' });
    expect(addons.twenty.setAccess).not.toHaveBeenCalled();
  });

  it('passes Make changes when the default stays chosen', async () => {
    const addons = stubAddons([listing()]);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect(addons.install).toHaveBeenCalledWith('twenty', { access: 'write' });
  });

  it('shows pending changes even with nothing set up', async () => {
    stubAddons([listing()], { pending: ['Disconnect crm-work'] });
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Run it on this Mac' })).toBeTruthy();
    const bar = await screen.findByRole('status');
    expect(within(bar).getByText('Disconnect crm-work')).toBeTruthy();
  });

  it('says so when the workspace files can’t be read, and still shows the setup', async () => {
    const addons = stubAddons([listing()]);
    addons.twenty.workspaces.mockRejectedValue(new Error('The workspaces folder is unreadable.'));
    renderDetail();
    expect(await screen.findByText('Couldn’t read Twenty’s workspaces: The workspaces folder is unreadable.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Run it on this Mac' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Will it fit on this Mac?' })).toBeTruthy();
  });

  it('describes the tools as the mock does', async () => {
    stubAddons([listing()]);
    renderDetail();
    expect(
      await screen.findByText(
        '7 tools per workspace. Every record change goes through execute_tool. Unattended runs, such as scheduled tasks, get the read-only key whatever you choose here.'
      )
    ).toBeTruthy();
    expect(screen.getByText('5 more')).toBeTruthy();
  });
});

describe('workspace list', () => {
  it('names a local and a hosted workspace', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace(), hostedWorkspace('work', { access: 'read' })] });
    renderDetail();
    const local = await screen.findByRole('listitem', { name: 'On this Mac crm-main' });
    expect(within(local).getByText('localhost:3000 · 4 containers · data stays on this Mac')).toBeTruthy();
    const hosted = screen.getByRole('listitem', { name: 'Hosted crm-work' });
    expect(within(hosted).getByText('https://crm.example.com · read-only and read-write keys')).toBeTruthy();
    expect(within(hosted).getByText('Limits depend on the role you gave the read-only key in Twenty.')).toBeTruthy();
    expect(within(local).queryByText('Limits depend on the role you gave the read-only key in Twenty.')).toBeNull();
  });

  it('disables Look things up without a read-only key', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace(), hostedWorkspace('work', { hasReadKey: false })] });
    renderDetail();
    const hosted = await screen.findByRole('listitem', { name: 'Hosted crm-work' });
    const lookup = within(hosted).getByRole('radio', { name: 'Look things up' }) as HTMLButtonElement;
    expect(lookup.disabled).toBe(true);
    expect(lookup.title).toBe('Add a read-only key first');
    expect(within(hosted).getByText('https://crm.example.com · read-write key only')).toBeTruthy();
  });

  it('shows why the bootstrap skips a workspace in place of the switch', async () => {
    stubAddons([listing({}, true)], {
      workspaces: [localWorkspace(), hostedWorkspace('odd', { skippedReason: 'TWENTY_ACCESS is “admin”; use read or write.' })],
    });
    renderDetail();
    const hosted = await screen.findByRole('listitem', { name: 'Hosted crm-odd' });
    expect(within(hosted).getByText('TWENTY_ACCESS is “admin”; use read or write.')).toBeTruthy();
    expect(within(hosted).queryByRole('radiogroup')).toBeNull();
  });

  it('sets access, reads the files again and lists the change in the pending bar', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace(), hostedWorkspace('work')] });
    renderDetail();
    const hosted = await screen.findByRole('listitem', { name: 'Hosted crm-work' });
    addons.twenty.setAccess.mockImplementation(async () => {
      addons.emitPending(['crm-work: look things up']);
      return { success: true };
    });
    fireEvent.click(within(hosted).getByRole('radio', { name: 'Look things up' }));
    expect(addons.twenty.setAccess).toHaveBeenCalledWith('work', 'read');
    const bar = await screen.findByRole('status');
    expect(within(bar).getByText('Restart the assistant to finish this change')).toBeTruthy();
    expect(within(bar).getByText('crm-work: look things up')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Restart assistant' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Later' })).toBeTruthy();
    await vi.waitFor(() => expect(addons.twenty.workspaces.mock.calls.length).toBeGreaterThan(1));
  });

  it('shows why a refused access change failed', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace(), hostedWorkspace('work')] });
    addons.twenty.setAccess.mockResolvedValue({ success: false, error: 'An install is running.' });
    renderDetail();
    const hosted = await screen.findByRole('listitem', { name: 'Hosted crm-work' });
    fireEvent.click(within(hosted).getByRole('radio', { name: 'Look things up' }));
    expect(await screen.findByText('An install is running.')).toBeTruthy();
  });
});

describe('pending restart bar', () => {
  it('Restart assistant applies the pending changes', async () => {
    const addons = stubAddons([listing({}, true)], {
      workspaces: [localWorkspace()],
      pending: ['crm-main: look things up', 'Disconnect crm-old'],
    });
    addons.applyPending.mockImplementation(() => new Promise(() => undefined));
    renderDetail();
    expect(await screen.findByText('Restart the assistant to finish these 2 changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart assistant' }));
    expect(addons.applyPending).toHaveBeenCalled();
    expect(await screen.findByText('Restarting…')).toBeTruthy();
    await act(async () => addons.emitPending([]));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers Restart when the task finishes while agent work runs', async () => {
    const addons = stubAddons([listing({}, true)], {
      workspaces: [localWorkspace()],
      pending: ['crm-main: look things up'],
      work: [codingTask],
    });
    renderDetail();
    await screen.findByRole('button', { name: 'Restart when the task finishes' });
    expect(screen.getByText('Inbox cleanup')).toBeTruthy();
    expect(screen.getByText(/A coding task is running in/).textContent).toBe(
      'A coding task is running in Inbox cleanup. Restarting now stops it; it can be resumed afterwards.'
    );
    expect(screen.queryByRole('button', { name: 'Restart assistant' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
  });

  it('restarts a queued restart once no agent work runs', async () => {
    const addons = stubAddons([listing({}, true)], {
      workspaces: [localWorkspace()],
      pending: ['crm-main: look things up'],
      work: [codingTask],
    });
    renderDetail();
    const queue = await screen.findByRole('button', { name: 'Restart when the task finishes' });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fireEvent.click(queue);
    expect(screen.getByRole('button', { name: 'Restarts when the task finishes' })).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(5000));
    expect(addons.applyPending).not.toHaveBeenCalled();
    addons.runningWork.mockResolvedValue([]);
    await act(async () => vi.advanceTimersByTime(5000));
    expect(addons.applyPending).toHaveBeenCalledTimes(1);
  });

  it('Later folds the bar to a note that keeps the restart one click away', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()], pending: ['crm-main: make changes'] });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart assistant' }));
    expect(addons.applyPending).toHaveBeenCalled();
  });

  it('keeps the error and the running-work notice in the folded view', async () => {
    const addons = stubAddons([listing({}, true)], {
      workspaces: [localWorkspace()],
      pending: ['crm-main: make changes'],
    });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    addons.applyPending.mockResolvedValue({ success: false, error: 'The assistant did not come back.' });
    fireEvent.click(screen.getByRole('button', { name: 'Restart assistant' }));
    expect(await screen.findByText('The assistant did not come back.')).toBeTruthy();
  });

  it('opens the bar again when the list changes', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()], pending: ['crm-main: make changes'] });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    await act(async () => addons.emitPending(['crm-main: make changes', 'Disconnect crm-old']));
    expect(await screen.findByRole('button', { name: 'Later' })).toBeTruthy();
    expect(screen.getByText('Restart the assistant to finish these 2 changes')).toBeTruthy();
  });

  it('shows why a restart failed', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()], pending: ['crm-main: make changes'] });
    addons.applyPending.mockResolvedValue({ success: false, error: 'The assistant did not come back.' });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart assistant' }));
    expect(await screen.findByText('The assistant did not come back.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart assistant' })).toBeTruthy();
  });
});

describe('opening Twenty', () => {
  it('Open Twenty calls the main-process opener and shows its warning', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    addons.twenty.open.mockResolvedValue({ success: true, warning: 'Opened without signing in.' });
    renderDetail();
    const local = await screen.findByRole('listitem', { name: 'On this Mac crm-main' });
    fireEvent.click(within(local).getByRole('button', { name: 'Open Twenty' }));
    expect(addons.twenty.open).toHaveBeenCalled();
    expect(await screen.findByText('Opened without signing in.')).toBeTruthy();
  });

  it('shows why opening failed', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    addons.twenty.open.mockResolvedValue({ success: false, error: 'Twenty isn’t answering.' });
    renderDetail();
    const local = await screen.findByRole('listitem', { name: 'On this Mac crm-main' });
    fireEvent.click(within(local).getByRole('button', { name: 'Open Twenty' }));
    expect(await screen.findByText('Twenty isn’t answering.')).toBeTruthy();
  });

  it('Copy password says when Boundary clears the clipboard', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    renderDetail();
    const local = await screen.findByRole('listitem', { name: 'On this Mac crm-main' });
    expect(within(local).getByText('owner@crm.localhost')).toBeTruthy();
    fireEvent.click(within(local).getByRole('button', { name: 'Copy password' }));
    expect(addons.twenty.copyPassword).toHaveBeenCalled();
    expect(
      await screen.findByText('Owner password copied. Boundary clears it from the clipboard in 60 seconds.')
    ).toBeTruthy();
  });
});

describe('Disconnect', () => {
  it('confirms, then disconnects and reads the files again', async () => {
    const addons = stubAddons([listing({}, true)], { workspaces: [localWorkspace(), hostedWorkspace('work')] });
    renderDetail();
    const hosted = await screen.findByRole('listitem', { name: 'Hosted crm-work' });
    fireEvent.click(within(hosted).getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog', { name: 'Disconnect crm-work?' });
    expect(within(dialog).getByText(/Agents lose this workspace after the next assistant restart\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await vi.waitFor(() => expect(addons.twenty.disconnect).toHaveBeenCalledWith('work'));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await vi.waitFor(() => expect(addons.twenty.workspaces.mock.calls.length).toBeGreaterThan(1));
  });
});

describe('move steps', () => {
  const both = () => ({ workspaces: [localWorkspace(), hostedWorkspace('work')] });

  it('appear with the local Twenty on and a hosted workspace, and follow the checkbox', async () => {
    const addons = stubAddons([listing({}, true)], both());
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Moving to crm-work?' })).toBeTruthy();
    const copyStep = () => screen.getByText('Copy your records').closest('li')!;
    expect(copyStep().dataset.done).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'I’ve copied what I need' }));
    expect(copyStep().dataset.done).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off this Mac’s Twenty' }));
    expect(screen.getByRole('dialog', { name: 'Turn off this Mac’s Twenty?' })).toBeTruthy();
    expect(addons.turnOff).not.toHaveBeenCalled();
  });

  it('opens this Mac’s Twenty from step 2', async () => {
    const addons = stubAddons([listing({}, true)], both());
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Open this Mac’s Twenty' }));
    expect(addons.twenty.open).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open crm-work' })).toBeTruthy();
  });

  it('hide on Keep both', async () => {
    stubAddons([listing({}, true)], both());
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Keep both' }));
    expect(screen.queryByRole('heading', { name: 'Moving to crm-work?' })).toBeNull();
  });

  it('are absent with only the local workspace', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace()] });
    renderDetail();
    await screen.findByRole('listitem', { name: 'On this Mac crm-main' });
    expect(screen.queryByRole('heading', { name: /Moving to/ })).toBeNull();
  });
});

describe('Turn off copy', () => {
  it('says the restart is still to come and what stays', async () => {
    stubAddons([listing({}, true)], { workspaces: [localWorkspace(), hostedWorkspace('work')] });
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn off this Mac’s Twenty?' });
    expect(dialog.textContent).toContain(
      'Its containers stop and agents lose crm-main after the next assistant restart. Agents keep crm-work. Its data stays on this Mac, and turning it on again picks up where you left off.'
    );
  });
});

describe('hosted only', () => {
  it('shows the workspace list and offers to run Twenty here as well', async () => {
    stubAddons([listing()], { workspaces: [hostedWorkspace('work')] });
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Run it on this Mac' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect a hosted workspace' })).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText(/Nothing runs here for a hosted workspace/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Also run Twenty on this Mac' }));
    expect(screen.getByRole('heading', { name: 'Run it on this Mac' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Will it fit on this Mac?' })).toBeTruthy();
  });
});

describe('Twenty off with its data kept', () => {
  it('shows an Off row with Turn on and no access switch', async () => {
    const addons = stubAddons([listing()], { workspaces: [localWorkspace({ parked: true })] });
    const started = renderDetail();
    const local = await screen.findByRole('listitem', { name: 'On this Mac crm-main' });
    expect(within(local).getByText('Off')).toBeTruthy();
    expect(within(local).getByText('Containers stopped. Its data stays on this Mac.')).toBeTruthy();
    expect(within(local).queryByRole('radiogroup')).toBeNull();
    fireEvent.click(within(local).getByRole('button', { name: 'Turn on' }));
    expect(addons.install).toHaveBeenCalledWith('twenty');
    expect(started).toHaveBeenCalled();
  });
});

