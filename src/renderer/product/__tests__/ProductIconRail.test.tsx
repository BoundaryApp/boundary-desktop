import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CIRCLE_KEY, circleSharing, circleSnapshot, runningCircles } from '../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductIconRail } from '../ProductIconRail';
import { setKanbanSnapshotForTests } from '../chat/kanbanActivity';
import type { AnchorBoxes, Guide, Release } from '../../../shared/types/releaseNotes';
import type { WhatsNewSnapshot } from '../../../shared/types/whatsNew';
import { resetWhatsNewForTests } from '../whatsNew/state';

const whatsNewBundled = vi.hoisted(() => ({ releases: [] as Release[] }));
vi.mock('../whatsNew/content', () => ({
  loadReleases: (): Release[] => whatsNewBundled.releases,
  loadGuide: (): Guide | null => null,
  imageUrl: (): string | null => null,
  anchorBoxes: (): AnchorBoxes => ({}),
}));

const useAssistantStackStatus = vi.fn();
const needsAttention = vi.fn(() => false);

vi.mock('../../experiments', () => ({
  experimentDestinations: () => [
    { id: 'demo', label: 'Demo', Icon: (): null => null, Screen: (): null => null, useAttention: () => needsAttention() },
    { id: 'plain', label: 'Plain', Icon: (): null => null, Screen: (): null => null },
  ],
}));

vi.mock('../assistantStack', () => ({
  useAssistantStackStatus: () => useAssistantStackStatus(),
}));

describe('ProductIconRail stack badge', () => {
  afterEach(() => {
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

describe('ProductIconRail sharing dot', () => {
  const sharingState = runningCircles({
    circles: [circleSnapshot({ myRole: 'admin' })],
    sharing: circleSharing({ models: [{ id: 'qwen3-8b', tools: true }], circles: [CIRCLE_KEY] }),
  });

  afterEach(() => {
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
    const dot = screen.queryByRole('img', { name: 'Members can’t use your models' });
    expect(dot !== null).toBe(shown);
    // The dot is on Inference, where the fix is (ADR 0043 §9), not on Circles.
    if (dot) expect(dot.closest('button')?.getAttribute('aria-label')).toMatch(/^Inference/);
  });
});

describe('ProductIconRail working dot', () => {
  afterEach(() => {
    setKanbanSnapshotForTests({ available: false, tasks: [], checkedAt: 0 });
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
          failures: 0,
        },
      ],
    });
    const { rerender } = render(<ProductIconRail active="settings" />);
    expect(screen.getByRole('img', { name: 'An agent is working' })).toBeTruthy();
    rerender(<ProductIconRail active="chat" />);
    expect(screen.queryByRole('img', { name: 'An agent is working' })).toBeNull();
  });
});

describe('ProductIconRail Circle unread', () => {
  afterEach(() => {
    useAssistantStackStatus.mockReset();
  });

  it.each([
    [true, '3 unread in Circles, mentions you', '@3'],
    [false, '3 unread in Circles', '3'],
  ])('with a mention %s on the Circles icon, and none on Chat', async (mentioned, name, text) => {
    useAssistantStackStatus.mockReturnValue(null);
    const state = runningCircles({ circles: [circleSnapshot()] });
    stubElectronAPI({
      circles: {
        getState: vi.fn().mockResolvedValue(state),
        chatChannels: vi.fn().mockResolvedValue({
          success: true,
          state,
          channels: [{ id: 'general', name: 'General', unread: 3, mentioned }],
        }),
        onChatEvent: vi.fn((): (() => void) => () => undefined),
        onChannelsChanged: vi.fn((): (() => void) => () => undefined),
      },
    });
    render(<ProductIconRail active="chat" />);
    await act(async () => undefined);
    await act(async () => undefined);
    const count = screen.getByRole('img', { name });
    expect(count.textContent).toBe(text);
    expect(count.closest('button')?.getAttribute('aria-label')).toBe('Circles');
    expect(screen.getByRole('button', { name: 'Chat' }).querySelector('.wb-icon-count')).toBeNull();
  });

  it('puts the same total on the app icon, and clears it when the rail is disabled', async () => {
    useAssistantStackStatus.mockReturnValue(null);
    const state = runningCircles({ circles: [circleSnapshot()] });
    const setBadge = vi.fn().mockResolvedValue(undefined);
    stubElectronAPI({
      appBadge: { set: setBadge },
      circles: {
        getState: vi.fn().mockResolvedValue(state),
        chatChannels: vi.fn().mockResolvedValue({
          success: true,
          state,
          channels: [{ id: 'general', name: 'General', unread: 3, mentioned: false }],
        }),
        onChatEvent: vi.fn((): (() => void) => () => undefined),
        onChannelsChanged: vi.fn((): (() => void) => () => undefined),
      },
    });
    const { rerender } = render(<ProductIconRail active="chat" />);
    await act(async () => undefined);
    await act(async () => undefined);
    expect(setBadge).toHaveBeenLastCalledWith({ count: 3 });

    rerender(<ProductIconRail active="chat" disabled />);
    expect(setBadge).toHaveBeenLastCalledWith({ count: 0 });
  });
});

describe('ProductIconRail experiment attention dot', () => {
  beforeEach(() => useAssistantStackStatus.mockReturnValue(null));
  afterEach(() => needsAttention.mockReset().mockReturnValue(false));

  it('draws a dot and extends the name while useAttention returns true', () => {
    needsAttention.mockReturnValue(true);
    render(<ProductIconRail active="chat" />);
    const button = screen.getByRole('button', { name: 'Demo, needs attention' });
    expect(button.querySelector('.wb-attention-dot')).not.toBeNull();
  });

  it('shows neither while it returns false, or when a destination has no useAttention', () => {
    render(<ProductIconRail active="chat" />);
    const button = screen.getByRole('button', { name: 'Demo' });
    expect(button.querySelector('.wb-attention-dot')).toBeNull();
    const plain = screen.getByRole('button', { name: 'Plain' });
    expect(plain.querySelector('.wb-attention-dot')).toBeNull();
  });
});

describe('ProductIconRail What’s new button', () => {
  afterEach(() => {
    resetWhatsNewForTests();
    whatsNewBundled.releases = [];
  });

  const railWith = (over: Partial<WhatsNewSnapshot> = {}) => {
    useAssistantStackStatus.mockReturnValue({ stack: { kind: 'managed', root: '/x' } });
    stubElectronAPI({
      whatsNew: {
        getState: vi.fn(async () => ({
          currentVersion: '0.0.1-rc.11',
          upgradedFrom: '0.0.1-rc.10',
          firstInstall: false,
          seen: [],
          popups: true,
          ...over,
        })),
      },
    });
    return render(<ProductIconRail active="chat" />);
  };

  it('is absent from the rail when no content is bundled', async () => {
    railWith();
    await waitFor(() => expect(screen.queryByLabelText('What’s new')).toBeNull());
  });

  it('shows a dot while a release is unseen', async () => {
    whatsNewBundled.releases = [
      {
        version: '0.0.1-rc.11',
        date: 'Nov 13',
        slides: [{ title: 'A feature', body: 'What it does.' }],
        guides: [],
      },
    ];
    railWith();
    const button = await screen.findByLabelText('What’s new');
    expect(button.querySelector('.wb-attention-dot')).toBeTruthy();
  });

  it('drops the dot once everything has been seen', async () => {
    whatsNewBundled.releases = [
      {
        version: '0.0.1-rc.11',
        date: 'Nov 13',
        slides: [{ title: 'A feature', body: 'What it does.' }],
        guides: [],
      },
    ];
    railWith({ seen: ['0.0.1-rc.11'] });
    const button = await screen.findByLabelText('What’s new');
    expect(button.querySelector('.wb-attention-dot')).toBeNull();
  });
});
