import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as ipcCalls from './ipcCalls';
import { dispatchAppCommand } from '../../useAppShortcuts';
import { requestChatOpen } from '../chatOpenRequests';
import { readChatDraft, resetChatDraftsForTests } from '../chatDrafts';
import { startNewChatWithDraft } from '../newChatDraft';
import {
  addSourceFolder,
  changeFolder,
  createAgent,
  createEmptyProject,
  createHermesChat,
  createHostProject,
  deleteChannel,
  deleteFailedChat,
  grantCodingFolder,
  inspectSources,
  listAgents,
  listChannels,
  listMentions,
  listProjects,
  listThreads,
  openAgentDm,
  pickCodingFolder,
  renameChannel,
  renderScreen,
  setLastOpened,
  setUpScreen,
  tearDownScreen,
  updateAgent,
} from './workbenchChatScreenHarness';

vi.mock('../HermesChatRuntimeProvider', () => import('./workbenchChatScreenMocks'));
vi.mock('../WorkbenchThread', () => import('./workbenchChatScreenMocks'));

describe('WorkbenchChatScreen chrome', () => {
  beforeEach(setUpScreen);
  afterEach(tearDownScreen);

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
    expect(screen.getByText(/^No agents yet\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create one' })).toBeTruthy();
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

  it('opens the chat the desktop panel’s ⤢ asked for (ADR 0058 §10)', async () => {
    await renderScreen();
    expect(screen.getByText('thread:Plan the launch')).toBeTruthy();
    await act(async () => requestChatOpen('t-webui'));
    expect(screen.getByText('thread:Resume summary')).toBeTruthy();
    expect(setLastOpened).toHaveBeenCalledWith({ kind: 'hermes', id: 't-webui' });
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

    async function deleteOpenRoom(projectId: string | null, deletedProjectId = projectId) {
      listChannels.mockResolvedValue({
        success: true,
        channels: [room(projectId)],
        lastOpened: { kind: 'channel', id: 'ch1' },
      });
      listThreads.mockResolvedValue({ success: true, threads: threadsFor(projectId) });
      deleteChannel.mockResolvedValue({
        success: true,
        sessionIds: ['t-ch'],
        projectId: deletedProjectId,
      });
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

    // A room whose project was removed lists under No project, but its stored id once came
    // back from the delete and the rail switched to that empty project.
    it('keeps the rail on No project when the room’s stored project is gone', async () => {
      await deleteOpenRoom(null, 'p-removed');
      expect(await screen.findByText('thread:Elsewhere chat')).toBeTruthy();
      expect(screen.getByRole('button', { name: /Elsewhere chat/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /launch-prep/ })).toBeTruthy();
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

  it('keeps Mentions open when it was clicked before the first chat list arrived', async () => {
    let answer: (value: unknown) => void = () => undefined;
    listThreads.mockReturnValue(
      ipcCalls.hold(
        new Promise((resolve) => {
          answer = resolve;
        })
      )
    );
    await renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Mentions' }));
    expect(screen.getByRole('button', { name: 'Mentions' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    await act(async () => {
      answer({ success: true, threads: [] });
    });
    await ipcCalls.settle();
    expect(screen.getByRole('button', { name: 'Mentions' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
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

  it('ends the Agents roster with Done then New agent, and Done closes it', async () => {
    await renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'All agents…' }));
    const roster = screen.getByRole('dialog', { name: 'Agents' });
    expect(within(roster).queryByText(/fourth app destination/)).toBeNull();
    expect(within(roster).queryByRole('button', { name: 'Back' })).toBeNull();

    const footer = roster.querySelector('.wb-sheet-actions');
    expect(
      Array.from(footer?.querySelectorAll('button') ?? []).map((b) => b.textContent)
    ).toEqual(['Done', 'New agent']);

    fireEvent.click(within(roster).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Agents' })).toBeNull();
  });

  it('shows Starting… while an agent is created, then opens its DM', async () => {
    let answer: (value: unknown) => void = () => undefined;
    createAgent.mockReturnValue(
      ipcCalls.hold(
        new Promise((resolve) => {
          answer = resolve;
        })
      )
    );
    openAgentDm.mockResolvedValue({
      success: true,
      thread: { id: 't-ben', title: 'DM · Ben', agentSlug: 'ben', kind: 'dm' },
    });
    await renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'All agents…' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Agents' })).getByRole('button', { name: 'New agent' })
    );
    const sheet = screen.getByRole('dialog', { name: 'New agent' });
    fireEvent.change(within(sheet).getByLabelText('Display name'), { target: { value: 'Ben' } });
    fireEvent.change(within(sheet).getByLabelText('Role'), { target: { value: 'Edits.' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create agent' }));
    expect(within(sheet).getByText('Starting…')).toBeTruthy();

    await act(async () => {
      answer({
        success: true,
        starting: true,
        agent: { slug: 'ben', displayName: 'Ben', handle: 'ben', role: 'Edits.', builtIn: false },
      });
    });
    await ipcCalls.settle();
    await waitFor(() =>
      expect(openAgentDm).toHaveBeenCalledWith({ agentSlug: 'ben', projectId: 'p1' })
    );
    expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull();
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

  it('says so when Give coding access meets a coding task that started meanwhile', async () => {
    pickCodingFolder.mockResolvedValue({
      success: true,
      hostPath: '/Users/ada/Code/portfolio',
      name: 'portfolio',
      isGit: true,
      refuseMessage: null,
      managed: true,
    });
    grantCodingFolder.mockResolvedValue({
      success: false,
      managed: true,
      grants: [],
      error: 'A coding task is running.',
      busy: { busy: true, sessions: ['Fix the build'] },
    });
    await renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Add…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Give coding access' }));

    await waitFor(() => expect(grantCodingFolder).toHaveBeenCalled());
    expect(
      await screen.findByText(/A coding task started, so portfolio wasn’t added/)
    ).toBeTruthy();
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
            description: 'Vault note',
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
    // An extra folder is a source of this project, never a project of its own in the picker.
    expect(screen.queryByRole('button', { name: 'notes-vault' })).toBeNull();
  });

  it('deletes a failed chat and lands on the newest one left', async () => {
    deleteFailedChat.mockResolvedValue({ success: true });
    listThreads.mockResolvedValue({
      success: true,
      threads: [
        {
          id: 'failed-1',
          title: 'Plan my week',
          kind: 'hermes',
          agentSlug: 'assistant',
          failed: true,
          updatedAt: '2026-10-31T10:00:00.000Z',
        },
        {
          id: 'stored-1',
          title: 'Stored chat',
          kind: 'hermes',
          agentSlug: 'assistant',
          updatedAt: '2026-10-30T10:00:00.000Z',
        },
      ],
    });
    await renderScreen();
    expect(screen.getByText('thread:Plan my week')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete chat…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete chat' }));
    await ipcCalls.settle();

    expect(deleteFailedChat).toHaveBeenCalledWith({ sessionId: 'failed-1' });
    expect(screen.getByText('thread:Stored chat')).toBeTruthy();
    expect(screen.queryByText('Plan my week')).toBeNull();
    // A chat Hermes holds has no delete.
    expect(screen.queryByRole('button', { name: 'Delete chat…' })).toBeNull();
  });

  it('starts a new chat from the New Chat command', async () => {
    await renderScreen();
    act(() => dispatchAppCommand('new-chat'));
    // A new chat starts in the project the rail shows (ADR 0024 §1).
    await waitFor(() => expect(createHermesChat).toHaveBeenCalledWith({ projectId: 'p1' }));
    await waitFor(() => expect(screen.getByText('thread:New chat')).toBeTruthy());
    expect(setLastOpened).toHaveBeenCalledWith({ kind: 'hermes', id: 't-new' });
  });

  // The thread and runtime are mocked here, so the draft is checked where the composer reads
  // it: the stored draft for the new chat's id (chatRuntimeHost seeds the composer from it).
  it('starts a chat with text ready to edit, and the next new chat starts empty', async () => {
    resetChatDraftsForTests();
    await renderScreen();
    act(() => startNewChatWithDraft('hello'));
    await waitFor(() => expect(createHermesChat).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readChatDraft(['t-new'])).toBe('hello'));

    resetChatDraftsForTests();
    act(() => dispatchAppCommand('new-chat'));
    await waitFor(() => expect(createHermesChat).toHaveBeenCalledTimes(2));
    await ipcCalls.settle();
    expect(readChatDraft(['t-new'])).toBeNull();
  });

  it('drops the text when the chat cannot be created, so a later new chat starts empty', async () => {
    resetChatDraftsForTests();
    await renderScreen();
    createHermesChat.mockResolvedValueOnce({ success: false, error: 'no' });
    act(() => startNewChatWithDraft('hello'));
    await waitFor(() => expect(createHermesChat).toHaveBeenCalledTimes(1));
    await ipcCalls.settle();

    act(() => dispatchAppCommand('new-chat'));
    await waitFor(() => expect(createHermesChat).toHaveBeenCalledTimes(2));
    await ipcCalls.settle();
    expect(readChatDraft(['t-new'])).toBeNull();
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
});
