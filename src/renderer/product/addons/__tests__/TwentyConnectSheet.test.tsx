import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TwentyConnectSheet } from '../TwentyConnectSheet';
import { ADDON_SLUG_RULE } from '../addonCopy';
import { stubAddons, listing } from './addonFixtures';

function open(existing: string[] = [], onClose = vi.fn()) {
  const addons = stubAddons([listing()]);
  render(<TwentyConnectSheet open existing={existing} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Connect a hosted Twenty workspace' });
  const field = (name: string | RegExp) => within(dialog).getByLabelText(name) as HTMLInputElement;
  const submit = () => within(dialog).getByRole('button', { name: /^Check and/ }) as HTMLButtonElement;
  const fill = (url: string, slug: string, rw: string, ro = '') => {
    fireEvent.change(field('Twenty address'), { target: { value: url } });
    fireEvent.change(field('Name'), { target: { value: slug } });
    fireEvent.change(field('Read-write API key'), { target: { value: rw } });
    if (ro) fireEvent.change(field(/Read-only API key/), { target: { value: ro } });
  };
  return { addons, dialog, field, submit, fill, onClose };
}

describe('TwentyConnectSheet', () => {
  it('keeps the key fields hidden and out of autofill', () => {
    const { field } = open();
    for (const name of ['Read-write API key', /Read-only API key/]) {
      expect(field(name).type).toBe('password');
      expect(field(name).getAttribute('autocomplete')).toBe('off');
    }
  });

  it('enables Check and connect only for a valid address, name and the chosen access’s key', () => {
    const { fill, submit, dialog } = open();
    expect(submit().disabled).toBe(true);
    fill('crm.example.com', 'work', 'rw-key');
    expect(submit().disabled).toBe(true);
    fill('https://crm.example.com', 'Work!', 'rw-key');
    expect(submit().disabled).toBe(true);
    fill('https://crm.example.com', 'main', 'rw-key');
    expect(submit().disabled).toBe(true);
    // The add-on store's rule: a letter first, at most 31 characters.
    fill('https://crm.example.com', '2024-crm', 'rw-key');
    expect(submit().disabled).toBe(true);
    expect(within(dialog).getByText(ADDON_SLUG_RULE)).toBeTruthy();
    fill('https://crm.example.com', `w${'x'.repeat(31)}`, 'rw-key');
    expect(submit().disabled).toBe(true);
    fill('https://crm.example.com', 'work', 'rw-key');
    expect(submit().disabled).toBe(false);
    fill('http://crm.example.com', 'work', 'rw-key');
    expect(submit().disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Look things up/ }));
    expect(submit().disabled).toBe(true);
    expect(within(dialog).getByText('Look things up needs the read-only key.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/Read-only API key/), { target: { value: 'ro-key' } });
    expect(submit().disabled).toBe(false);
  });

  it('offers Replace it for an existing name, then Check and replace', () => {
    const { fill, submit, dialog, addons } = open(['work']);
    fill('https://crm.example.com', 'work', 'rw-key');
    expect(within(dialog).getByText(/crm-work already exists\./)).toBeTruthy();
    expect(submit().disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace it' }));
    expect(submit().textContent).toBe('Check and replace');
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    expect(addons.twenty.connect).toHaveBeenCalledWith(expect.objectContaining({ slug: 'work', replace: true }));
  });

  it('sends the input, then closes and reads the workspaces again on success', async () => {
    const { fill, submit, addons, onClose } = open();
    addons.twenty.connect.mockResolvedValue({ success: true, result: { ok: true, checks: [] } });
    fill('https://crm.example.com', 'work', 'rw-key', 'ro-key');
    fireEvent.click(submit());
    expect(addons.twenty.connect).toHaveBeenCalledWith({
      slug: 'work',
      url: 'https://crm.example.com',
      keyRw: 'rw-key',
      keyRo: 'ro-key',
      access: 'write',
      replace: false,
    });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    await vi.waitFor(() => expect(addons.twenty.workspaces).toHaveBeenCalled());
  });

  it('names the rejected key and says nothing was saved', async () => {
    const { fill, submit, addons, onClose } = open();
    addons.twenty.connect.mockResolvedValue({
      success: true,
      result: { ok: false, reason: 'rejected', key: 'RW', status: 401, message: 'Twenty rejects TWENTY_KEY_RW (HTTP 401)', checks: [] },
    });
    fill('https://crm.example.com', 'work', 'rw-key');
    fireEvent.click(submit());
    expect(await screen.findByText('Twenty rejected the read-write key')).toBeTruthy();
    expect(screen.getByText('Nothing was saved.')).toBeTruthy();
    expect(screen.getByText(/It answered 401/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false);
  });

  it('says the server lacks the catalog tools after both keys pass', async () => {
    const { fill, submit, addons, dialog } = open();
    addons.twenty.connect.mockResolvedValue({
      success: true,
      result: {
        ok: false,
        reason: 'no-catalog',
        message: 'https://crm.example.com/mcp?mode=meta lists 4 tools but not execute_tool',
        checks: [],
      },
    });
    fill('https://crm.example.com', 'work', 'rw-key');
    fireEvent.click(submit());
    expect(await screen.findByText('This Twenty doesn’t list the tools agents use')).toBeTruthy();
    expect(screen.getByText('Nothing was saved.')).toBeTruthy();
    expect(within(dialog).getByText(/Checking the tools Twenty lists/)).toBeTruthy();
  });

  it('says there was no answer, and shows a call that failed', async () => {
    const { fill, submit, addons } = open();
    addons.twenty.connect.mockResolvedValueOnce({
      success: true,
      result: { ok: false, reason: 'no-answer', message: 'no answer from https://crm.example.com', checks: [] },
    });
    fill('https://crm.example.com', 'work', 'rw-key');
    fireEvent.click(submit());
    expect(await screen.findByText('No answer from https://crm.example.com')).toBeTruthy();
    addons.twenty.connect.mockResolvedValueOnce({ success: false, error: 'The stack isn’t running.' });
    fireEvent.click(submit());
    expect(await screen.findByText('The stack isn’t running.')).toBeTruthy();
  });

  it('a name that already exists in the stack offers Replace it', async () => {
    const { fill, submit, addons, dialog } = open();
    addons.twenty.connect.mockResolvedValue({
      success: true,
      result: { ok: false, reason: 'exists', message: 'crm-work exists; pass --force', checks: [] },
    });
    fill('https://crm.example.com', 'work', 'rw-key');
    fireEvent.click(submit());
    expect(await within(dialog).findByRole('button', { name: 'Replace it' })).toBeTruthy();
  });

  it('forgets the keys when the sheet closes', () => {
    const addons = stubAddons([listing()]);
    const { rerender } = render(<TwentyConnectSheet open existing={[]} onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Read-write API key'), { target: { value: 'secret' } });
    rerender(<TwentyConnectSheet open={false} existing={[]} onClose={() => undefined} />);
    rerender(<TwentyConnectSheet open existing={[]} onClose={() => undefined} />);
    expect((screen.getByLabelText('Read-write API key') as HTMLInputElement).value).toBe('');
    expect(addons.twenty.connect).not.toHaveBeenCalled();
  });
});
