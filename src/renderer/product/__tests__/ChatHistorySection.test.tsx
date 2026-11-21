import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatHistoryState, ChatHistoryStatus } from '../../../shared/types/chatHistory';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ChatHistorySection, IMPORT_NEEDS_NEWER_STACK } from '../ChatHistorySection';

const status = vi.fn<() => Promise<ChatHistoryStatus>>();
const exportHistory = vi.fn();
const cancel = vi.fn();
const reveal = vi.fn();
let send: (state: ChatHistoryState) => void = () => undefined;

stubElectronAPI({
  chatHistory: {
    status: () => status(),
    export: () => exportHistory(),
    cancel: () => cancel(),
    reveal: (folder: string) => reveal(folder),
    onChanged: (listener: (state: ChatHistoryState) => void) => {
      send = listener;
      return (): void => undefined;
    },
  },
});

beforeEach(() => {
  status.mockReset().mockResolvedValue({ state: { phase: 'idle' }, unavailable: null });
  exportHistory.mockReset().mockResolvedValue({ success: true, started: true });
  cancel.mockReset().mockResolvedValue(true);
  reveal.mockReset().mockResolvedValue({ success: true });
});

describe('ChatHistorySection (ADR 0070)', () => {
  it('offers Export and shows Import disabled with the newer-stack line', async () => {
    render(<ChatHistorySection />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect((screen.getByRole('button', { name: 'Import history…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(IMPORT_NEEDS_NEWER_STACK)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export history…' }));
    expect(exportHistory).toHaveBeenCalledOnce();
  });

  it('shows each profile as it exports, with Cancel, then the result and the backup note', async () => {
    render(<ChatHistorySection />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    const profiles = [{ profile: 'coder', label: 'Coder', sessions: 2, messages: 7 }];
    act(() => send({ phase: 'exporting', folder: '/x/Boundary history 2026-11-20', profiles, cancelling: false }));
    expect(screen.getByText('Coder: 2 chats, 7 messages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();

    act(() => send({ phase: 'exported', folder: '/x/Boundary history 2026-11-20', profiles, sessions: 2, messages: 7 }));
    expect(screen.getByText('/x/Boundary history 2026-11-20')).toBeTruthy();
    expect(screen.getByText(/holds your whole chats, unencrypted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(reveal).toHaveBeenCalledWith('/x/Boundary history 2026-11-20');
  });

  it('disables both actions on a remote stack host, with the reason', async () => {
    status.mockResolvedValue({ state: { phase: 'idle' }, unavailable: 'Your agent runs on another computer.' });
    render(<ChatHistorySection />);
    expect(await screen.findByText('Your agent runs on another computer.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Export history…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Import history…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a failed export’s error', async () => {
    render(<ChatHistorySection />);
    await waitFor(() => expect(status).toHaveBeenCalled());
    act(() => send({ phase: 'failed', error: 'The agent isn’t running.' }));
    expect(screen.getByText('The agent isn’t running.')).toBeTruthy();
  });
});
