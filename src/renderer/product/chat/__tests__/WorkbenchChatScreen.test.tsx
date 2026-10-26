import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChatScreenSnapshot } from '../chatScreenCache';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

const listThreads = vi.fn();
const listProjects = vi.fn();
const inspectSources = vi.fn();
const addSourceFolder = vi.fn();
const pickCodingFolder = vi.fn();
const removeSource = vi.fn();
const revealSource = vi.fn();
const refreshIndex = vi.fn();
const createHostProject = vi.fn();
const changeFolder = vi.fn();
const selectProject = vi.fn();
const listAgents = vi.fn();
const createHermesChat = vi.fn();
const openAgentDm = vi.fn();
const createAgent = vi.fn();
const updateAgent = vi.fn();
const listChannels = vi.fn();
const createChannel = vi.fn();
const addChannelMember = vi.fn();
const renameChannel = vi.fn();
const deleteChannel = vi.fn();
const makeChannelFromHermesChat = vi.fn();
const setLastOpened = vi.fn();
const createEmptyProject = vi.fn();
const listMentions = vi.fn();
const markMentionsSeen = vi.fn();
const moveToProject = vi.fn();
const undoProjectMove = vi.fn();
const listProjectMarks = vi.fn();
const countProjectSources = vi.fn();

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: ipcCalls.track(vi.fn().mockResolvedValue({ configured: true, slots: {} })),
    probeSlotHealth: ipcCalls.track(vi.fn().mockResolvedValue({ success: true })),
  },
}));

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    listThreads: ipcCalls.track((...args: unknown[]) => listThreads(...args)),
    listProjects: ipcCalls.track((...args: unknown[]) => listProjects(...args)),
    selectProject: ipcCalls.track((...args: unknown[]) => selectProject(...args)),
    listAgents: ipcCalls.track((...args: unknown[]) => listAgents(...args)),
    createHermesChat: ipcCalls.track((...args: unknown[]) => createHermesChat(...args)),
    openAgentDm: ipcCalls.track((...args: unknown[]) => openAgentDm(...args)),
    createAgent: ipcCalls.track((...args: unknown[]) => createAgent(...args)),
    updateAgent: ipcCalls.track((...args: unknown[]) => updateAgent(...args)),
    listChannels: ipcCalls.track((...args: unknown[]) => listChannels(...args)),
    createChannel: ipcCalls.track((...args: unknown[]) => createChannel(...args)),
    addChannelMember: ipcCalls.track((...args: unknown[]) => addChannelMember(...args)),
    renameChannel: ipcCalls.track((...args: unknown[]) => renameChannel(...args)),
    deleteChannel: ipcCalls.track((...args: unknown[]) => deleteChannel(...args)),
    makeChannelFromHermesChat: ipcCalls.track((...args: unknown[]) =>
      makeChannelFromHermesChat(...args)
    ),
    setLastOpened: ipcCalls.track((...args: unknown[]) => setLastOpened(...args)),
    pickFolder: vi.fn(),
    createEmptyProject: ipcCalls.track((...args: unknown[]) => createEmptyProject(...args)),
    createHostProject: ipcCalls.track((...args: unknown[]) => createHostProject(...args)),
    changeFolder: ipcCalls.track((...args: unknown[]) => changeFolder(...args)),
    revealInFinder: vi.fn(),
    inspectSources: ipcCalls.track((...args: unknown[]) => inspectSources(...args)),
    addSourceFolder: ipcCalls.track((...args: unknown[]) => addSourceFolder(...args)),
    pickCodingFolder: ipcCalls.track((...args: unknown[]) => pickCodingFolder(...args)),
    listCodingFolders: ipcCalls.track(
      vi.fn(async () => ({ success: true, managed: true, grants: [] }))
    ),
    codingAgentBusy: ipcCalls.track(vi.fn(async () => ({ busy: false, sessions: [] }))),
    onCodingFoldersProgress: vi.fn(() => () => undefined),
    removeSource: ipcCalls.track((...args: unknown[]) => removeSource(...args)),
    revealSource: ipcCalls.track((...args: unknown[]) => revealSource(...args)),
    refreshIndex: ipcCalls.track((...args: unknown[]) => refreshIndex(...args)),
    getAgentSoul: ipcCalls.track(
      vi.fn().mockResolvedValue({ success: true, excerpt: null, canOpen: false })
    ),
    revealAgentSoul: ipcCalls.track(vi.fn().mockResolvedValue({ success: true })),
    onSessionsChanged: () => () => undefined,
    listMentions: ipcCalls.track((...args: unknown[]) => listMentions(...args)),
    markMentionsSeen: ipcCalls.track((...args: unknown[]) => markMentionsSeen(...args)),
    moveToProject: ipcCalls.track((...args: unknown[]) => moveToProject(...args)),
    undoProjectMove: ipcCalls.track((...args: unknown[]) => undoProjectMove(...args)),
    listProjectMarks: ipcCalls.track((...args: unknown[]) => listProjectMarks(...args)),
    countProjectSources: ipcCalls.track((...args: unknown[]) => countProjectSources(...args)),
    getSessionInference: ipcCalls.track(
      vi.fn().mockResolvedValue({ success: true, override: null, marks: [] })
    ),
  },
}));

vi.mock('../HermesChatRuntimeProvider', () => ({
  HermesChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('../WorkbenchThread', () => ({
  WorkbenchThread: ({
    threadTitle,
    kind,
    isChannel,
    initialDraft,
    initialQuote,
    focusText,
    dmTabs,
    onCreateAgentFromDraft,
    onRenameChannel,
    onDeleteChannel,
  }: {
    threadTitle: string;
    kind?: string | null;
    isChannel?: boolean;
    initialDraft?: string | null;
    initialQuote?: string | null;
    focusText?: string | null;
    dmTabs?: { count: number; onChange: (tab: 'messages' | 'channels') => void } | null;
    onCreateAgentFromDraft?: (payload: { displayName: string; handle: string; role: string }) => void;
    onRenameChannel?: () => void;
    onDeleteChannel?: () => void;
  }) => (
    <div>
      thread:{threadTitle}
      {kind === 'side' ? ' side' : ''}
      {isChannel ? ' channel' : ''}
      {initialDraft ? <p>draft:{initialDraft}</p> : null}
      {initialQuote ? <p>quote:{initialQuote}</p> : null}
      {focusText ? <p>focus:{focusText}</p> : null}
      {onRenameChannel ? (
        <button type="button" onClick={onRenameChannel}>
          Rename channel…
        </button>
      ) : null}
      {onDeleteChannel ? (
        <button type="button" onClick={onDeleteChannel}>
          Delete channel…
        </button>
      ) : null}
      {onCreateAgentFromDraft ? (
        <button
          type="button"
          onClick={() =>
            onCreateAgentFromDraft({ displayName: 'Hermes', handle: 'hermes', role: 'Helps.' })
          }
        >
          Create drafted agent
        </button>
      ) : null}
      {dmTabs ? (
        <button type="button" onClick={() => dmTabs.onChange('channels')}>
          In channels {dmTabs.count}
        </button>
      ) : null}
    </div>
  ),
}));

import { WorkbenchChatScreen } from '../WorkbenchChatScreen';
import { resetCodingFoldersStoreForTests } from '../codingFoldersStore';
import { dispatchAppCommand } from '../../useAppShortcuts';

/** Renders the screen once its first loads (chats, projects, agents, folders) are in. */
async function renderScreen() {
  render(<WorkbenchChatScreen />);
  await ipcCalls.settle();
}

describe('WorkbenchChatScreen chrome', () => {
  afterEach(async () => {
    // Let calls still in flight answer before the next test's mocks are set up.
    await ipcCalls.settle();
    cleanup();
    vi.clearAllMocks();
    // The coding-folders store is module state; a fresh screen starts from nothing loaded.
    resetCodingFoldersStoreForTests();
  });

  beforeEach(() => {
    clearChatScreenSnapshot();
    listAgents.mockResolvedValue({
      success: true,
      agents: [
        {
          slug: 'assistant',
          displayName: 'Hermes',
          handle: 'Hermes',
          role: 'Default agent on this machine.',
          builtIn: true,
          createdAt: '1970-01-01T00:00:00.000Z',
        },
      ],
      standingDmByAgent: {},
    });
    listThreads.mockResolvedValue({
      success: true,
      threads: [
        {
          id: 't-hermes',
          title: 'Plan the launch',
          source: 'boundary',
          agentSlug: 'assistant',
          kind: 'hermes', projectId: 'p1',
          updatedAt: new Date().toISOString(),
        },
        {
          id: 't-webui',
          title: 'Resume summary',
          source: 'webui',
          agentSlug: 'assistant',
          kind: 'hermes', projectId: 'p1',
          updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
        },
      ],
    });
    listProjects.mockResolvedValue({
      success: true,
      activeId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Job Search',
          hostPath: '/Users/ada/Documents/Job Search',
          containerPath: '/opt/projects/job-search',
          slug: 'job-search',
          kind: 'host-folder',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    inspectSources.mockResolvedValue({
      success: true,
      inspect: {
        projectId: 'p1',
        registryExists: false,
        stale: false,
        sources: [
          {
            id: 'project',
            path: '.',
            hostPath: '/Users/ada/Documents/Job Search',
            retrieval: 'files',
            visibility: 'hub',
            isHub: true,
          },
        ],
        index: [],
      },
    });
    addSourceFolder.mockResolvedValue({ success: false, canceled: true });
    pickCodingFolder.mockResolvedValue({
      success: true,
      hostPath: '/Users/ada/Notes/this-project',
      name: 'this-project',
      isGit: false,
      refuseMessage: null,
      managed: true,
    });
    selectProject.mockResolvedValue({ success: true });
    listChannels.mockResolvedValue({
      success: true,
      channels: [],
      lastOpened: null,
    });
    setLastOpened.mockResolvedValue({ success: true });
    listMentions.mockResolvedValue({ success: true, mentions: [] });
    markMentionsSeen.mockResolvedValue({ success: true });
    listProjectMarks.mockResolvedValue([]);
    countProjectSources.mockResolvedValue(0);
    createHermesChat.mockResolvedValue({
      success: true,
      thread: {
        id: 't-new',
        title: 'New chat',
        agentSlug: 'assistant',
        kind: 'hermes', projectId: 'p1',
      },
    });
  });

  it('uses a current-project picker with All chats, Hermes, Channels and Direct messages', async () => {
    await renderScreen();

    await waitFor(() => {
      expect(screen.getByText('Hermes')).toBeTruthy();
    });

    // 0003: no top-level New project / New chat — project create lives in the picker;
    // conversation creates live on section plus buttons (0007/0008).
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(screen.queryByText('Projects')).toBeNull();
    // ADR 0024: the picker navigates to a project; it never re-points the open chat.
    expect(screen.getByRole('button', { name: 'Go to project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All chats' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All chats in Job Search…' })).toBeTruthy();
    expect(screen.getByText('Channels')).toBeTruthy();
    expect(screen.getByText('Direct messages')).toBeTruthy();
    expect(screen.queryByText('Chats')).toBeNull();
    expect(screen.getByRole('button', { name: 'New Hermes chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Message an agent' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New channel' })).toBeTruthy();
    // The built-in agent has chats, not a DM row (ADR 0023).
    expect(screen.getByText('No agents yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All agents…' })).toBeTruthy();
    expect(screen.getByText(/^No channels (in .+\.|yet\.)$/)).toBeTruthy();

    // Default land is the newest Hermes chat, not the All chats list (ADR 0023).
    expect(screen.getByText('thread:Plan the launch')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'All chats' })).toBeNull();
    // Hermes chats from elsewhere sit in the Hermes section with their source.
    const webuiRow = screen.getByRole('button', { name: /Resume summary/ });
    expect(within(webuiRow).getByText('WebUI')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getAllByText('Job Search').length).toBeGreaterThan(0);
    });
  });

  it('renames the open channel from its title menu (ADR 0010 §3)', async () => {
    const room = {
      id: 'ch1',
      slug: 'launch-prep',
      title: 'launch-prep',
      sessionId: 't-ch',
      memberSlugs: ['assistant'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    };
    listChannels.mockResolvedValue({
      success: true,
      channels: [room],
      lastOpened: { kind: 'channel', id: 'ch1' },
    });
    listThreads.mockResolvedValue({
      success: true,
      threads: [
        {
          id: 't-ch',
          title: '#launch-prep',
          source: 'boundary',
          kind: 'channel',
          channelId: 'ch1',
          channelSlug: 'launch-prep',
          agentSlug: 'assistant',
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    renameChannel.mockResolvedValue({
      success: true,
      channel: { ...room, title: 'Pricing', slug: 'pricing' },
    });
    await renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Rename channel…' }));
    const sheet = screen.getByRole('dialog', { name: 'Rename #launch-prep' });
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Pricing' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Rename' }));

    expect(await screen.findByText('thread:#pricing channel')).toBeTruthy();
    expect(renameChannel).toHaveBeenCalledWith({
      channelId: 'ch1',
      title: 'Pricing',
      slug: 'pricing',
    });
    expect(screen.queryByRole('dialog', { name: /Rename/ })).toBeNull();
    expect(screen.queryByText('#launch-prep')).toBeNull();
  });

  describe('deleting the open channel (ADR 0010 §3)', () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const room = (projectId: string | null) => ({
      id: 'ch1',
      slug: 'launch-prep',
      title: 'launch-prep',
      sessionId: 't-ch',
      memberSlugs: ['assistant'],
      projectId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: at(0),
    });
    const threadsFor = (projectId: string | null) => [
      {
        id: 't-ch',
        title: '#launch-prep',
        source: 'boundary',
        kind: 'channel',
        channelId: 'ch1',
        channelSlug: 'launch-prep',
        agentSlug: 'assistant',
        projectId,
        updatedAt: at(0),
      },
      {
        id: 't-elsewhere',
        title: 'Elsewhere chat',
        source: 'boundary',
        kind: 'hermes',
        agentSlug: 'assistant',
        projectId: null,
        updatedAt: at(1),
      },
      {
        id: 't-in-project',
        title: 'Project chat',
        source: 'boundary',
        kind: 'hermes',
        agentSlug: 'assistant',
        projectId: 'p1',
        updatedAt: at(5),
      },
    ];

    async function deleteOpenRoom(projectId: string | null) {
      listChannels.mockResolvedValue({
        success: true,
        channels: [room(projectId)],
        lastOpened: { kind: 'channel', id: 'ch1' },
      });
      listThreads.mockResolvedValue({ success: true, threads: threadsFor(projectId) });
      deleteChannel.mockResolvedValue({ success: true, sessionIds: ['t-ch'], projectId });
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete channel…' }));
      const sheet = screen.getByRole('dialog', { name: 'Delete #launch-prep' });
      const lede = within(sheet).getByText(/transcript stays as a Hermes chat in/).textContent;
      const mentionLoads = listMentions.mock.calls.length;
      fireEvent.click(within(sheet).getByRole('button', { name: 'Delete channel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /Delete/ })).toBeNull());
      return { lede, mentionLoads };
    }

    it('lands on the newest other chat in the room’s project', async () => {
      const { lede, mentionLoads } = await deleteOpenRoom('p1');
      expect(lede).toContain('Job Search');
      expect(deleteChannel).toHaveBeenCalledWith({ channelId: 'ch1' });
      expect(await screen.findByText('thread:Project chat')).toBeTruthy();
      expect(listMentions.mock.calls.length).toBeGreaterThan(mentionLoads);
      expect(screen.queryByRole('list', { name: 'All chats' })).toBeNull();
    });

    it('uses the usual landing for a room with no project', async () => {
      const { lede } = await deleteOpenRoom(null);
      expect(lede).toContain('No project');
      expect(await screen.findByText('thread:Elsewhere chat')).toBeTruthy();
    });
  });

  it('lists channels in the rail and lands on a room when lastOpened is a channel', async () => {
    listChannels.mockResolvedValue({
      success: true,
      channels: [
        {
          id: 'ch1',
          slug: 'launch-prep',
          title: 'launch-prep',
          sessionId: 't-ch',
          memberSlugs: ['assistant'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: new Date().toISOString(),
        },
      ],
      lastOpened: { kind: 'channel', id: 'ch1' },
    });
    listThreads.mockResolvedValue({
      success: true,
      threads: [
        {
          id: 't-ch',
          title: '#launch-prep',
          source: 'boundary',
          kind: 'channel',
          channelId: 'ch1',
          channelSlug: 'launch-prep',
          agentSlug: 'assistant',
          updatedAt: new Date().toISOString(),
        },
        {
          id: 't-hermes',
          title: 'Plan the launch',
          source: 'boundary',
          agentSlug: 'assistant',
          kind: 'hermes', projectId: 'p1',
          updatedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });

    await renderScreen();

    await waitFor(() => {
      expect(screen.getAllByText('#launch-prep').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('thread:#launch-prep channel')).toBeTruthy();
    expect(screen.queryByText(/thread:Assistant/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'All chats' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Room' })).toBeTruthy();
    expect(screen.getByText('Default agent')).toBeTruthy();
    expect(screen.queryByText(/Members of this room\. They read posts later/)).toBeNull();
  });

  it('treats a last-opened channel as a room even when the session is missing from the thread list', async () => {
    listChannels.mockResolvedValue({
      success: true,
      channels: [
        {
          id: 'ch-orphan',
          slug: 'general',
          title: 'general',
          sessionId: 't-missing',
          memberSlugs: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: new Date().toISOString(),
        },
      ],
      lastOpened: { kind: 'channel', id: 'ch-orphan' },
    });

    await renderScreen();

    await waitFor(() => {
      expect(screen.getAllByText('#general').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('thread:#general channel')).toBeTruthy();
    expect(screen.queryByText(/thread:Assistant/)).toBeNull();
  });

  it('shows the previous chats at once when it remounts after Settings', async () => {
    const { WorkbenchChatScreen } = await import('../WorkbenchChatScreen');
    const first = render(<WorkbenchChatScreen />);
    await waitFor(() => {
      expect(screen.getAllByText('Plan the launch').length).toBeGreaterThan(0);
    });
    first.unmount();

    // The next refresh hangs: the rail must not wait for it.
    listThreads.mockReturnValue(ipcCalls.hold(new Promise(() => undefined)));
    render(<WorkbenchChatScreen />);
    expect(screen.getAllByText('Plan the launch').length).toBeGreaterThan(0);
  });

  it('opens All chats as a destination listing Hermes chats from elsewhere', async () => {
    await renderScreen();

    await waitFor(() => {
      expect(screen.getByText('Hermes')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'All chats' }));

    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'All chats' })).toBeTruthy();
    });
    const list = screen.getByRole('list', { name: 'All chats' });
    expect(within(list).getByText('Resume summary')).toBeTruthy();
    expect(within(list).getByText(/Hermes chat · from WebUI/)).toBeTruthy();
  });

  it('opens create-agent sheet from All agents roster', async () => {
    await renderScreen();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'All agents…' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'All agents…' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Agents' })).getByRole('button', { name: 'New agent' })
    );
    expect(screen.getByRole('dialog', { name: 'New agent' })).toBeTruthy();
    expect(screen.getByText('The role becomes its standing instructions.')).toBeTruthy();
  });

  describe('editing an agent (ADR 0010 §4)', () => {
    const ana = {
      slug: 'ana',
      displayName: 'Ana',
      handle: 'ana',
      role: 'Find vendors.',
      builtIn: false,
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    const hermesAgent = {
      slug: 'assistant',
      displayName: 'Hermes',
      handle: 'Hermes',
      role: 'Default agent on this machine.',
      builtIn: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    };

    async function openEditForAna() {
      listAgents.mockResolvedValue({
        success: true,
        agents: [hermesAgent, ana],
        standingDmByAgent: { ana: null },
      });
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: 'All agents…' }));
      const roster = screen.getByRole('dialog', { name: 'Agents' });
      expect(within(roster).queryByRole('button', { name: 'Edit Hermes' })).toBeNull();
      fireEvent.click(within(roster).getByRole('button', { name: 'Edit Ana' }));
      return screen.getByRole('dialog', { name: 'Edit agent' });
    }

    it('edits a personality from the roster, but never the built-in agent', async () => {
      const sheet = await openEditForAna();
      expect(within(sheet).getByDisplayValue('Find vendors.')).toBeTruthy();
      fireEvent.change(within(sheet).getByLabelText('Role'), {
        target: { value: 'Compare pricing.' },
      });
      updateAgent.mockResolvedValue({ success: true, agent: { ...ana, role: 'Compare pricing.' } });
      const loads = listAgents.mock.calls.length;
      fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit agent' })).toBeNull());
      expect(updateAgent).toHaveBeenCalledWith({
        slug: 'ana',
        displayName: 'Ana',
        handle: 'ana',
        role: 'Compare pricing.',
      });
      expect(listAgents.mock.calls.length).toBeGreaterThan(loads);
      expect(createAgent).not.toHaveBeenCalled();
    });

    it('says when SOUL.md kept its own edits', async () => {
      const sheet = await openEditForAna();
      updateAgent.mockResolvedValue({ success: true, agent: ana, soulKept: true });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(/SOUL\.md has your own edits/)).toBeTruthy();
    });
  });

  it('opens the create sheet with the error when Create on a draft card fails', async () => {
    createAgent.mockResolvedValueOnce({ success: false, error: 'Hermes is the built-in agent.' });
    await renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Create drafted agent' }));

    const sheet = await screen.findByRole('dialog', { name: 'New agent' });
    expect(within(sheet).getByText('Hermes is the built-in agent.')).toBeTruthy();
    expect(within(sheet).getByDisplayValue('Helps.')).toBeTruthy();
  });

  it('shows Folders on the right rail and keeps extras out of the picker', async () => {
    await renderScreen();

    await waitFor(() => {
      expect(screen.getByText('Hub')).toBeTruthy();
    });
    expect(screen.getByText('Folders')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'notes-vault' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    expect(screen.getByRole('dialog', { name: 'Choose a folder on this Mac' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    // Not a git repo, so reference is preselected (ADR 0028).
    fireEvent.click(await screen.findByRole('button', { name: 'Add as reference' }));
    await waitFor(() => {
      expect(addSourceFolder).toHaveBeenCalledWith({
        projectId: 'p1',
        hostPath: '/Users/ada/Notes/this-project',
      });
    });
    expect(createHostProject).not.toHaveBeenCalled();
    expect(changeFolder).not.toHaveBeenCalled();
  });

  it('shows the next-step card for an unmounted extra instead of a ready pill', async () => {
    inspectSources.mockResolvedValue({
      success: true,
      inspect: {
        projectId: 'p1',
        registryExists: true,
        stale: true,
        sources: [
          {
            id: 'project',
            path: '.',
            hostPath: '/Users/ada/Documents/Job Search',
            retrieval: 'files',
            visibility: 'hub',
            isHub: true,
          },
          {
            id: 'notes-vault',
            path: '/Users/ada/Notes/this-project',
            hostPath: '/Users/ada/Notes/this-project',
            retrieval: 'files',
            visibility: 'unmounted',
            isHub: false,
          },
        ],
        index: [
          {
            sourceId: 'notes-vault',
            path: '/Users/ada/Notes/this-project/foo.md',
            description: 'Foo',
            kind: 'absolute',
            visible: false,
          },
        ],
        nextStep: {
          tone: 'deny',
          title: 'notes-vault isn’t visible yet.',
          body: 'Remount from this screen, then Refresh index.',
        },
      },
    });

    await renderScreen();

    await waitFor(() => {
      expect(screen.getByText('notes-vault isn’t visible yet.')).toBeTruthy();
    });
    expect(screen.getAllByText('Not visible').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ready')).toBeNull();
    expect(screen.queryByText(/make context-root-add/)).toBeNull();
    expect(screen.queryByText('/Users/ada/Notes/this-project/foo.md')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open' }).length).toBeGreaterThan(0);
  });

  it('shows Read-only and Refresh index after a remounted extra', async () => {
    inspectSources.mockResolvedValue({
      success: true,
      inspect: {
        projectId: 'p1',
        registryExists: true,
        stale: true,
        sources: [
          {
            id: 'project',
            path: '.',
            hostPath: '/Users/ada/Documents/Job Search',
            retrieval: 'files',
            visibility: 'hub',
            isHub: true,
          },
          {
            id: 'notes-vault',
            path: '/Users/ada/Notes/this-project',
            hostPath: '/Users/ada/Notes/this-project',
            retrieval: 'files',
            visibility: 'readonly',
            isHub: false,
          },
        ],
        index: [
          {
            sourceId: 'notes-vault',
            path: '/Users/ada/Notes/this-project/foo.md',
            description: 'Foo',
            kind: 'absolute',
            visible: true,
          },
        ],
        nextStep: {
          tone: 'ok',
          title: 'Index is behind the files.',
          body: 'Refresh rewrites INDEX.md from this Mac.',
        },
      },
    });

    await renderScreen();

    await waitFor(() => {
      expect(
      screen.getAllByText('Read-only').some((el) => el.closest('.wb-src'))
    ).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Project actions' }));
    expect(screen.getByRole('menuitem', { name: 'Refresh index' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'notes-vault' })).toBeNull();
    expect(createHostProject).not.toHaveBeenCalled();
  });

  it('starts a new chat from the New Chat command', async () => {
    await renderScreen();
    act(() => dispatchAppCommand('new-chat'));
    // A new chat starts in the project the rail shows (ADR 0024 §1).
    await waitFor(() => expect(createHermesChat).toHaveBeenCalledWith({ projectId: 'p1' }));
    await waitFor(() => expect(screen.getByText('thread:New chat')).toBeTruthy());
    expect(setLastOpened).toHaveBeenCalledWith({ kind: 'hermes', id: 't-new' });
  });

  it('creates an empty project from the empty rail', async () => {
    listProjects.mockResolvedValue({ success: true, activeId: null, projects: [] });
    const created = {
      id: 'p-empty',
      name: 'Trip planning',
      hostPath: '/data/projects/trip-planning',
      containerPath: '/opt/projects/trip-planning',
      slug: 'trip-planning',
      kind: 'empty',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    createEmptyProject.mockResolvedValue({
      success: true,
      project: created,
      projects: [created],
      activeId: 'p-empty',
    });
    await renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Create empty project' }));
    fireEvent.change(screen.getByPlaceholderText('Trip planning'), {
      target: { value: 'Trip planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(createEmptyProject).toHaveBeenCalledWith({ name: 'Trip planning' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Create empty project' })).toBeNull()
    );
  });

  describe('conversation kinds (ADR 0023)', () => {
    const ana = {
      slug: 'ana',
      displayName: 'Ana',
      handle: 'Ana',
      role: 'Researcher',
      builtIn: false,
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    const hermes = {
      slug: 'assistant',
      displayName: 'Hermes',
      handle: 'Hermes',
      role: 'Default agent on this machine.',
      builtIn: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

    beforeEach(() => {
      listAgents.mockResolvedValue({
        success: true,
        agents: [hermes, ana],
        standingDmByAgent: { ana: 't-ana' },
      });
      listThreads.mockResolvedValue({
        success: true,
        threads: [
          { id: 't-old', title: 'Older plan', agentSlug: 'assistant', kind: 'hermes', projectId: 'p1', updatedAt: at(30) },
          { id: 't-ana', title: 'DM · Ana', agentSlug: 'ana', kind: 'dm', updatedAt: at(1) },
          { id: 't-new', title: 'Newest plan', agentSlug: 'assistant', kind: 'hermes', projectId: 'p1', updatedAt: at(5) },
          { id: 't-side', title: 'Pricing · branch', agentSlug: 'ana', kind: 'side', projectId: 'p1', updatedAt: at(60) },
        ],
      });
    });

    it('lands on the last-opened DM', async () => {
      listChannels.mockResolvedValue({
        success: true,
        channels: [],
        lastOpened: { kind: 'dm', id: 't-ana' },
      });
      await renderScreen();
      expect(await screen.findByText('thread:Ana')).toBeTruthy();
    });

    it('lands on the newest Hermes chat, not a newer DM, when nothing was opened', async () => {
      await renderScreen();
      expect(await screen.findByText('thread:Newest plan')).toBeTruthy();
    });

    it('opens an empty Hermes composer when there are no chats', async () => {
      listThreads.mockResolvedValue({ success: true, threads: [] });
      await renderScreen();
      expect(await screen.findByText('thread:New chat')).toBeTruthy();
    });

    it("opens a personality's DM through openAgentDm when it is not loaded", async () => {
      listAgents.mockResolvedValue({
        success: true,
        agents: [hermes, ana],
        standingDmByAgent: { ana: 't-elsewhere' },
      });
      openAgentDm.mockResolvedValue({
        success: true,
        created: false,
        thread: { id: 't-elsewhere', title: 'DM · Ana', agentSlug: 'ana', kind: 'dm' },
      });
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByText('Ana'));
      await waitFor(() => expect(openAgentDm).toHaveBeenCalledWith({ agentSlug: 'ana', projectId: 'p1' }));
      expect(await screen.findByText('thread:Ana')).toBeTruthy();
    });

    it('lists Hermes chats newest first in the Hermes section and opens one', async () => {
      listChannels.mockResolvedValue({
        success: true,
        channels: [],
        lastOpened: { kind: 'dm', id: 't-ana' },
      });
      await renderScreen();
      await screen.findByText('thread:Ana');
      const rows = ['Newest plan', 'Older plan'].map((t) => screen.getByRole('button', { name: t }));
      expect(rows[0].compareDocumentPosition(rows[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Hermes\s*Default/ })).toBeNull();
      fireEvent.click(rows[0]);
      expect(await screen.findByText('thread:Newest plan')).toBeTruthy();
      expect(setLastOpened).toHaveBeenCalledWith({ kind: 'hermes', id: 't-new' });
    });

    it('opens the roster in message mode from the DMs plus and opens the DM', async () => {
      openAgentDm.mockResolvedValue({
        success: true,
        created: false,
        thread: { id: 't-ana', title: 'DM · Ana', agentSlug: 'ana', kind: 'dm' },
      });
      listAgents.mockResolvedValue({
        success: true,
        agents: [hermes, ana],
        standingDmByAgent: {},
      });
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByRole('button', { name: 'Message an agent' }));
      const dialog = screen.getByRole('dialog', { name: 'Message an agent' });
      expect(within(dialog).queryByText('Hermes')).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Message' }));
      await waitFor(() => expect(openAgentDm).toHaveBeenCalledWith({ agentSlug: 'ana', projectId: 'p1' }));
      expect(createHermesChat).not.toHaveBeenCalled();
    });

    it('opens All chats in the project from the Hermes section, and the top row resets it', async () => {
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByRole('button', { name: 'All chats in Job Search…' }));
      const list = await screen.findByRole('list', { name: 'All chats' });
      expect(
        (screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement).value
      ).toBe('p1');
      expect(within(list).getByText('Newest plan')).toBeTruthy();
      expect(within(list).getByText('Pricing · branch')).toBeTruthy();
      // A DM is never filed under a project (ADR 0024 §7).
      expect(within(list).queryByText('Ana')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      const reset = await screen.findByRole('list', { name: 'All chats' });
      expect(
        (screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement).value
      ).toBe('');
      expect(within(reset).getByText('Ana')).toBeTruthy();
    });

    it('lists every kind newest first, whatever order the list arrives in', async () => {
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      const list = await screen.findByRole('list', { name: 'All chats' });
      const titles = within(list)
        .getAllByRole('listitem')
        .map((row) => row.querySelector('.wb-jump-title')?.textContent);
      expect(titles).toEqual(['Ana', 'Newest plan', 'Older plan', 'Pricing · branch']);
    });

    it('says which filters are on when nothing matches, and Clear brings everything back', async () => {
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      fireEvent.click(await screen.findByRole('radio', { name: /Side chats/ }));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search all chats' }), {
        target: { value: 'nothing like this' },
      });
      expect(screen.getByRole('status').textContent).toContain(
        'No side chats matching “nothing like this”.'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      const list = screen.getByRole('list', { name: 'All chats' });
      expect(within(list).getByText('Newest plan')).toBeTruthy();
      expect(within(list).getByText('Ana')).toBeTruthy();
    });

    it('filters by agent from the agent menu and leaves All chats when a row opens', async () => {
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      fireEvent.change(await screen.findByRole('combobox', { name: 'Agent' }), {
        target: { value: 'ana' },
      });
      const list = screen.getByRole('list', { name: 'All chats' });
      expect(within(list).getByText('Ana')).toBeTruthy();
      expect(within(list).getByText('Pricing · branch')).toBeTruthy();
      expect(within(list).queryByText('Newest plan')).toBeNull();
      fireEvent.click(within(list).getByText('Ana'));
      expect(await screen.findByText('thread:Ana')).toBeTruthy();
      expect(screen.queryByRole('list', { name: 'All chats' })).toBeNull();
    });

    it('shows a side chat from All chats as a side chat', async () => {
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      expect(await screen.findByText('Side chat with Ana')).toBeTruthy();
      fireEvent.click(screen.getByText('Pricing · branch'));
      expect(await screen.findByText('thread:Pricing · branch side')).toBeTruthy();
    });
  });

  describe('Mentions (ADR 0023 §6)', () => {
    const ana = {
      slug: 'ana',
      displayName: 'Ana',
      handle: 'Ana',
      role: 'Researcher',
      builtIn: false,
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    const hermesAgent = {
      slug: 'assistant',
      displayName: 'Hermes',
      handle: 'Hermes',
      role: 'Default agent on this machine.',
      builtIn: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    };
    const room = {
      id: 'ch1',
      slug: 'research',
      title: 'research',
      sessionId: 's-room',
      memberSlugs: ['assistant', 'ana'],
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: new Date().toISOString(),
    };
    const now = new Date().toISOString();
    const record = (over: Record<string, unknown>) => ({
      id: 'p1:ana',
      channelId: 'ch1',
      channelSlug: 'research',
      sessionId: 's-room',
      agentSlug: 'ana',
      text: '@Ana pricing?',
      at: now,
      anchor: 'p1',
      status: 'replied',
      reply: { text: 'Two vendors.', at: now },
      unseen: true,
      ...over,
    });

    beforeEach(() => {
      listAgents.mockResolvedValue({
        success: true,
        agents: [hermesAgent, ana],
        standingDmByAgent: { ana: 't-ana' },
      });
      listChannels.mockResolvedValue({ success: true, channels: [room], lastOpened: { kind: 'dm', id: 't-ana' } });
      listThreads.mockResolvedValue({
        success: true,
        threads: [
          { id: 't-ana', title: 'DM · Ana', agentSlug: 'ana', kind: 'dm', updatedAt: now },
          { id: 's-room', title: '#research', kind: 'channel', channelId: 'ch1', channelSlug: 'research', agentSlug: 'assistant', updatedAt: now },
          { id: 't-h', title: 'Plan', agentSlug: 'assistant', kind: 'hermes', projectId: 'p1', updatedAt: now },
        ],
      });
      listMentions.mockResolvedValue({
        success: true,
        mentions: [
          record({}),
          record({ id: 'p2:ana', anchor: 'p2', text: '@Ana dates?', status: 'waiting', reply: undefined, unseen: false }),
          record({ id: 'p3:assistant', anchor: 'p3', agentSlug: 'assistant', text: '@Hermes sum up', reply: { text: 'Done.', at: now } }),
        ],
      });
    });

    it('counts unseen replies on the rail and clears the count when Mentions opens', async () => {
      await renderScreen();
      const row = await screen.findByRole('button', { name: 'Mentions, 2 new' });
      fireEvent.click(row);
      await waitFor(() => expect(markMentionsSeen).toHaveBeenCalled());
      expect(await screen.findByRole('button', { name: 'Mentions' })).toBeTruthy();
      // The cards keep their pills for this visit.
      expect(screen.getAllByText('New reply')).toHaveLength(2);
    });

    it("shows the DM agent's @s on its In channels tab, and resets to Messages", async () => {
      await renderScreen();
      await screen.findByText('thread:Ana');
      fireEvent.click(await screen.findByRole('button', { name: 'In channels 2' }));
      const list = await screen.findByRole('list', { name: 'Mentions' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
      expect(screen.getByRole('tab', { name: /In channels/ }).getAttribute('aria-selected')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
      expect(await screen.findByText('thread:Plan')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Ana/ }));
      expect(await screen.findByText('thread:Ana')).toBeTruthy();
    });

    it('opens a mention in its room, focused on your message', async () => {
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: /^Mentions/ }));
      const list = await screen.findByRole('list', { name: 'Mentions' });
      fireEvent.click(within(list).getAllByRole('button', { name: 'Open in #research' })[0]);
      expect(await screen.findByText('focus:@Ana pricing?')).toBeTruthy();
      expect(screen.getByText(/thread:#research/)).toBeTruthy();
    });

    it('continues in the DM with the exchange as a quote', async () => {
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: /^Mentions/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Continue in DM with Ana' }));
      expect(await screen.findByText(/quote:In #research you asked: @Ana pricing\?/)).toBeTruthy();
      expect(screen.getByText(/Ana: Two vendors\./)).toBeTruthy();
    });

    it('continues a Hermes mention in a new Hermes chat', async () => {
      createHermesChat.mockResolvedValue({
        success: true,
        thread: { id: 't-new', title: 'New chat', agentSlug: 'assistant', kind: 'hermes', projectId: 'p1' },
      });
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: /^Mentions/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Continue in a Hermes chat' }));
      await waitFor(() => expect(createHermesChat).toHaveBeenCalled());
      expect(await screen.findByText(/quote:In #research you asked: @Hermes sum up/)).toBeTruthy();
    });

    it('asks again by pre-filling the room composer, unsent', async () => {
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: /^Mentions/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Ask again' }));
      expect(await screen.findByText('draft:@Ana dates?')).toBeTruthy();
    });
  });
  describe('chats belong to projects (ADR 0024)', () => {
    const p2 = {
      id: 'p2',
      name: 'Landing site',
      hostPath: '/Users/ada/code/site',
      containerPath: '/opt/projects/site',
      slug: 'site',
      kind: 'host-folder',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
      listProjects.mockResolvedValue({
        success: true,
        activeId: 'p1',
        projects: [
          {
            id: 'p1',
            name: 'Job Search',
            hostPath: '/Users/ada/Documents/Job Search',
            containerPath: '/opt/projects/job-search',
            slug: 'job-search',
            kind: 'host-folder',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
          p2,
        ],
      });
      listThreads.mockResolvedValue({
        success: true,
        threads: [
          {
            id: 't-hermes',
            title: 'Plan the launch',
            agentSlug: 'assistant',
            kind: 'hermes',
            projectId: 'p1',
            updatedAt: new Date().toISOString(),
          },
          {
            id: 't-site',
            title: 'Hero rewrite',
            agentSlug: 'assistant',
            kind: 'hermes',
            projectId: 'p2',
            updatedAt: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
      });
    });

    it('opens a project page from the picker and leaves the open chat where it is', async () => {
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      // The rail lists only the shown project's chats.
      expect(screen.queryByRole('button', { name: 'Hero rewrite' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Go to project' }));
      fireEvent.click(screen.getByRole('option', { name: /Landing site/ }));

      await waitFor(() => expect(selectProject).toHaveBeenCalledWith({ projectId: 'p2' }));
      for (const [payload] of selectProject.mock.calls) {
        expect(payload).not.toHaveProperty('sessionId');
      }
      expect(await screen.findByLabelText('Start a chat in Landing site')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Hero rewrite' }).length).toBeGreaterThan(0);
      expect(moveToProject).not.toHaveBeenCalled();
    });

    it('brings the rail to a chat opened from another project', async () => {
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      const list = await screen.findByRole('list', { name: 'All chats' });
      fireEvent.click(within(list).getByText('Hero rewrite'));
      expect(await screen.findByText('thread:Hero rewrite')).toBeTruthy();
      await waitFor(() => expect(selectProject).toHaveBeenCalledWith({ projectId: 'p2' }));
      expect(await screen.findByRole('button', { name: 'All chats in Landing site…' })).toBeTruthy();
    });

    it('moves selected chats from All chats, says what changes, and undoes', async () => {
      moveToProject.mockResolvedValue({
        success: true,
        moved: [{ sessionId: 't-site', fromProjectId: 'p2', toProjectId: null, markId: 'm1' }],
      });
      undoProjectMove.mockResolvedValue({ success: true, moved: [] });
      await renderScreen();
      await screen.findByText('thread:Plan the launch');
      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      await screen.findByRole('list', { name: 'All chats' });
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select Hero rewrite' }));
      fireEvent.click(screen.getByRole('button', { name: 'Move to project…' }));

      const dialog = await screen.findByRole('dialog', { name: /Move “Hero rewrite”/ });
      // The sheet reads a source count, never the full inspect that reads every file.
      await waitFor(() => expect(countProjectSources).toHaveBeenCalledWith('p1'));
      const inspectsBefore = inspectSources.mock.calls.length;
      fireEvent.click(within(dialog).getByRole('radio', { name: /No project/ }));
      expect(within(dialog).getByText(/works without a project folder/)).toBeTruthy();
      expect(inspectSources.mock.calls.length).toBe(inspectsBefore);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move to No project' }));

      await waitFor(() =>
        expect(moveToProject).toHaveBeenCalledWith({ sessionIds: ['t-site'], projectId: null })
      );
      const toast = await screen.findByText('Moved to No project');
      fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
      await waitFor(() =>
        expect(undoProjectMove).toHaveBeenCalledWith({
          moves: [{ sessionId: 't-site', fromProjectId: 'p2', toProjectId: null, markId: 'm1' }],
        })
      );
      expect(await screen.findByText('Move undone')).toBeTruthy();
    });
  });
});
