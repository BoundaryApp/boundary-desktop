import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSearchModeState } from '../../../shared/webSearchMode';
import { WebSearchModeSection } from '../WebSearchModeSection';

const getWebSearchMode = vi.fn<() => Promise<WebSearchModeState>>();
const setWebSearchMode = vi.fn();

function stateWith(partial: Partial<WebSearchModeState> = {}): WebSearchModeState {
  return { mode: 'private', available: true, canChange: true, overrides: [], ...partial };
}

beforeEach(() => {
  getWebSearchMode.mockReset().mockResolvedValue(stateWith());
  setWebSearchMode.mockReset().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { assistantStack: { getWebSearchMode, setWebSearchMode } },
  });
});

afterEach(cleanup);

describe('WebSearchModeSection', () => {
  it('renders nothing on a stack pin without the setting', async () => {
    getWebSearchMode.mockResolvedValue(stateWith({ available: false }));
    const { container } = render(<WebSearchModeSection />);
    await waitFor(() => expect(getWebSearchMode).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('starts on Private only with no privacy note and nothing to save', async () => {
    render(<WebSearchModeSection />);
    const priv = await screen.findByRole('radio', { name: /Private only/ });
    expect(priv.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('note', { name: 'What leaves this computer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save and restart Hermes' })).toHaveProperty('disabled', true);
  });

  it('shows the privacy note before an outside mode is saved, then saves it', async () => {
    render(<WebSearchModeSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Private, fall back/ }));
    const note = screen.getByRole('note', { name: 'What leaves this computer' });
    expect(note.textContent).toContain('Exa, Parallel, Firecrawl and Keenable');
    expect(note.textContent).toContain('the search gate is busy');
    expect(setWebSearchMode).not.toHaveBeenCalled();

    getWebSearchMode.mockResolvedValue(stateWith({ mode: 'private-first' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and restart Hermes' }));
    await waitFor(() => expect(setWebSearchMode).toHaveBeenCalledWith('private-first'));
    expect(await screen.findByText('Saved. Hermes uses the new setting.')).toBeTruthy();
  });

  it('shows the error and keeps the saved mode when saving fails', async () => {
    setWebSearchMode.mockResolvedValue({ success: false, error: 'Couldn’t restart Hermes.' });
    render(<WebSearchModeSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Outside services only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and restart Hermes' }));
    expect(await screen.findByText('Couldn’t restart Hermes.')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Private only/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('names the Hermes .env files that override the setting', async () => {
    getWebSearchMode.mockResolvedValue(stateWith({ overrides: ['profiles/browser/.env'] }));
    render(<WebSearchModeSection />);
    expect(
      await screen.findByText(/hermes\/profiles\/browser\/\.env in the data folder sets HERMES_WEB_SEARCH_MODE/)
    ).toBeTruthy();
  });

  it('is read-only when the local stack’s .env decides', async () => {
    getWebSearchMode.mockResolvedValue(stateWith({ canChange: false, mode: 'keyless' }));
    render(<WebSearchModeSection />);
    expect(await screen.findByRole('radio', { name: /Outside services only/ })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Save and restart Hermes' })).toBeNull();
    expect(screen.getByText(/The local stack’s .env decides this/)).toBeTruthy();
  });
});
