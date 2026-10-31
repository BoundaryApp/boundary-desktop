import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductIconRail } from '../ProductIconRail';
import { setKanbanSnapshotForTests } from '../chat/kanbanActivity';

const useAssistantStackStatus = vi.fn();

vi.mock('../assistantStack', () => ({
  useAssistantStackStatus: () => useAssistantStackStatus(),
}));

describe('ProductIconRail stack badge', () => {
  afterEach(() => {
    cleanup();
    useAssistantStackStatus.mockReset();
  });

  it('marks a local agent stack with its root', () => {
    useAssistantStackStatus.mockReturnValue({ stack: { kind: 'local', root: '/dev/assistant' } });
    render(<ProductIconRail active="chat" />);
    expect(screen.getByText('Local').getAttribute('title')).toBe(
      'Local agent stack: /dev/assistant'
    );
  });

  it('shows nothing for the managed stack or before the status loads', () => {
    useAssistantStackStatus.mockReturnValue({ stack: { kind: 'managed', root: '/userData/project' } });
    const { rerender } = render(<ProductIconRail active="chat" />);
    expect(screen.queryByText('Local')).toBeNull();

    useAssistantStackStatus.mockReturnValue(null);
    rerender(<ProductIconRail active="chat" />);
    expect(screen.queryByText('Local')).toBeNull();
  });
});

describe('ProductIconRail Circles dot', () => {
  const KEY = 'c'.repeat(64);
  const sharingState = {
    status: 'running',
    displayName: 'Ada',
    snapshot: { identity: 'a'.repeat(64), circles: [{ key: KEY, name: 'Garden club', myRole: 'admin', members: [], invites: [], offers: [] }] },
    providers: {},
    sharing: { models: [{ id: 'qwen3-8b', tools: true }], circles: [KEY], paused: false, away: false },
  };

  afterEach(() => {
    cleanup();
    useAssistantStackStatus.mockReset();
  });

  it.each([
    ['unreachable', true],
    ['reachable', false],
  ])('with a shared local server %s: dot %s', async (health, shown) => {
    useAssistantStackStatus.mockReturnValue(null);
    stubElectronAPI({
      circles: { getState: vi.fn().mockResolvedValue(sharingState) },
      onboarding: {
        getStatus: vi.fn().mockResolvedValue({ configured: true, slots: { local: { configured: true, modelId: 'qwen3-8b', health } } }),
      },
    });
    render(<ProductIconRail active="chat" />);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(screen.queryByRole('img', { name: 'Members can’t use your models' }) !== null).toBe(shown);
  });
});

describe('ProductIconRail working dot', () => {
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
    cleanup();
  });

  it('counts a running kanban worker when you are off the chat screen', () => {
    useAssistantStackStatus.mockReturnValue(null);
    setKanbanSnapshotForTests({
      available: true,
      checkedAt: 0,
      tasks: [
        {
          id: 't_1',
          title: 'Audit',
          status: 'running',
          assignee: 'researcher',
          workspaceKind: 'scratch',
          workspacePath: null,
          createdBySession: null,
          createdAt: 0,
          startedAt: 0,
          completedAt: null,
          lastHeartbeatAt: 0,
          claimExpires: null,
          blockKind: null,
        },
      ],
    });
    const { rerender } = render(<ProductIconRail active="settings" />);
    expect(screen.getByRole('img', { name: 'An agent is working' })).toBeTruthy();
    rerender(<ProductIconRail active="chat" />);
    expect(screen.queryByRole('img', { name: 'An agent is working' })).toBeNull();
  });
});
