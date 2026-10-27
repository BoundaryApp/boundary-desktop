import React, { useEffect } from 'react';
import { within, act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { clearChatScreenSnapshot } from '../chatScreenCache';
import type { HermesChatThreadSummary } from '../../../../shared/types/hermesChat';

// The screen resolves a chat's stored id to a runtime id when it opens, and a later
// chat-list refresh brings the stored id back. A branch must stay marked through both.

const listThreads = vi.fn();
const branchChat = vi.fn();
const sessionsChanged = vi.hoisted(() => ({ notify: () => undefined as void }));

stubElectronAPI({
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ success: true }),
  },
  hermesChat: {
    listThreads: (...args: unknown[]) => listThreads(...args),
    branchChat: (...args: unknown[]) => branchChat(...args),
    onSessionsChanged: (cb: () => void) => {
      sessionsChanged.notify = cb;
      return () => undefined;
    },
  },
  projects: {
    list: vi.fn().mockResolvedValue({ success: true, activeId: null, projects: [] }),
    select: vi.fn().mockResolvedValue({ success: true }),
    inspectSources: vi.fn().mockResolvedValue({ success: false }),
  },
  agents: {
    list: vi.fn().mockResolvedValue({
      success: true,
      agents: [
        {
          slug: 'assistant',
          displayName: 'Hermes',
          handle: 'Hermes',
          role: 'Default',
          builtIn: true,
          createdAt: '1970-01-01T00:00:00.000Z',
        },
      ],
      standingDmByAgent: { assistant: 't-dm' },
    }),
    getSoul: vi.fn().mockResolvedValue({ success: true, excerpt: null, canOpen: false }),
  },
  channels: {
    list: vi.fn().mockResolvedValue({
      success: true,
      channels: [],
      lastOpened: { kind: 'dm', id: 't-dm' },
    }),
    setLastOpened: vi.fn().mockResolvedValue({ success: true }),
  },
});

// Stands in for the runtime provider: opening the branch resolves its stored id to a
// runtime id, as session.resume does.
vi.mock('../HermesChatRuntimeProvider', () => ({
  HermesChatRuntimeProvider: ({
    children,
    sessionId,
    onSessionResolved,
  }: {
    children: React.ReactNode;
    sessionId: string | null;
    onSessionResolved?: (id: string) => void;
  }) => {
    useEffect(() => {
      if (sessionId === 'br-stored') onSessionResolved?.('br-runtime');
    }, [sessionId, onSessionResolved]);
    return <>{children}</>;
  },
}));

vi.mock('../WorkbenchThread', () => ({
  WorkbenchThread: ({
    branchedFrom,
    initialDraft,
    onBranch,
  }: {
    branchedFrom?: { parentTitle: string; justBranched?: boolean } | null;
    initialDraft?: string | null;
    onBranch?: (request: { seed: unknown[]; draft?: string }) => void;
  }) => (
    <div>
      <p data-testid="branch">{branchedFrom ? `from ${branchedFrom.parentTitle}` : 'none'}</p>
      <p data-testid="toast">{branchedFrom?.justBranched ? 'toast' : 'no-toast'}</p>
      <p data-testid="draft">{initialDraft ?? 'no-draft'}</p>
      <button
        type="button"
        onClick={() =>
          onBranch?.({ seed: [{ role: 'user', content: 'first' }], draft: 'second' })
        }
      >
        do-branch
      </button>
    </div>
  ),
}));

import { WorkbenchChatScreen } from '../WorkbenchChatScreen';

const now = new Date().toISOString();
const dm: HermesChatThreadSummary = {
  id: 't-dm',
  title: 'Hermes',
  source: 'boundary',
  agentSlug: 'assistant',
  kind: 'hermes',
  updatedAt: now,
};
const branchThread: HermesChatThreadSummary = {
  id: 'br-stored',
  title: 'Assistant · branch',
  source: 'boundary',
  agentSlug: 'assistant',
  kind: 'hermes',
  updatedAt: now,
  branch: { parentId: 't-dm', parentTitle: 'Hermes', seededCount: 1, branchedAt: now },
};

describe('a branched chat stays marked as a branch', () => {
  beforeEach(() => {
    clearChatScreenSnapshot();
    listThreads.mockResolvedValue({ success: true, threads: [dm] });
    branchChat.mockResolvedValue({ success: true, thread: branchThread });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('right after branching, and after the chat list refreshes', async () => {
    render(<WorkbenchChatScreen />);
    const doBranch = await screen.findByRole('button', { name: 'do-branch' });

    await act(async () => fireEvent.click(doBranch));
    await waitFor(() => expect(screen.getByTestId('branch').textContent).toBe('from Hermes'));
    expect(screen.getByTestId('toast').textContent).toBe('toast');
    expect(screen.getByTestId('draft').textContent).toBe('second');

    // Hermes announces the new session; the list comes back with stored ids.
    listThreads.mockResolvedValue({ success: true, threads: [branchThread, dm] });
    await act(async () => sessionsChanged.notify());
    await waitFor(() => expect(listThreads).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('branch').textContent).toBe('from Hermes');
    expect(screen.getByTestId('toast').textContent).toBe('toast');
    expect(screen.getByTestId('draft').textContent).toBe('second');
  });

  it('when a branch is opened later from All chats', async () => {
    listThreads.mockResolvedValue({ success: true, threads: [branchThread, dm] });
    render(<WorkbenchChatScreen />);
    await screen.findByRole('button', { name: 'do-branch' });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'All chats' })));
    const list = await screen.findByRole('list', { name: 'All chats' });
    await act(async () => fireEvent.click(within(list).getByText('Assistant · branch')));
    const callsBefore = listThreads.mock.calls.length;
    await act(async () => sessionsChanged.notify());
    await waitFor(() => expect(listThreads.mock.calls.length).toBeGreaterThan(callsBefore));
    await act(async () => undefined);

    expect(screen.getByTestId('branch').textContent).toBe('from Hermes');
    expect(screen.getByTestId('toast').textContent).toBe('no-toast');
  });
});
