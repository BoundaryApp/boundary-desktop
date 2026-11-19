import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as ipcCalls from './ipcCalls';
import {
  createHermesChat,
  listAgents,
  listChannels,
  listThreads,
  openAgentDm,
  renderScreen,
  sessionsChanged,
  setLastOpened,
  setUpScreen,
  tearDownScreen,
} from './workbenchChatScreenHarness';

vi.mock('../HermesChatRuntimeProvider', () => import('./workbenchChatScreenMocks'));
vi.mock('../WorkbenchThread', () => import('./workbenchChatScreenMocks'));

describe('WorkbenchChatScreen chrome', () => {
  beforeEach(setUpScreen);
  afterEach(tearDownScreen);

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

    it('keeps the empty Hermes composer open when a refresh lists other chats', async () => {
      listThreads.mockResolvedValue({
        success: true,
        threads: [{ id: 't-ana', title: 'DM · Ana', agentSlug: 'ana', kind: 'dm', updatedAt: at(1) }],
      });
      await renderScreen();
      expect(await screen.findByText('thread:New chat')).toBeTruthy();
      const listsBefore = listThreads.mock.calls.length;

      // The refresh is debounced (SESSIONS_CHANGED_DEBOUNCE_MS, 400 ms).
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await act(async () => {
          for (const cb of [...sessionsChanged]) cb();
          await vi.advanceTimersByTimeAsync(400);
        });
      } finally {
        vi.useRealTimers();
      }
      await ipcCalls.settle();
      expect(listThreads.mock.calls.length).toBeGreaterThan(listsBefore);
      expect(screen.getByText('thread:New chat')).toBeTruthy();
      expect(screen.queryByText('thread:Ana')).toBeNull();
    });

    it('keeps the Tools switch per chat', async () => {
      await renderScreen();
      await screen.findByText('thread:Newest plan');
      const tools = () => screen.getByRole('switch', { name: 'Tools' });
      expect(tools().getAttribute('aria-checked')).toBe('true');
      fireEvent.click(tools());
      expect(tools().getAttribute('aria-checked')).toBe('false');

      fireEvent.click(screen.getByRole('button', { name: 'Older plan' }));
      expect(await screen.findByText('thread:Older plan')).toBeTruthy();
      expect(tools().getAttribute('aria-checked')).toBe('true');

      fireEvent.click(screen.getByRole('button', { name: 'Newest plan' }));
      expect(await screen.findByText('thread:Newest plan')).toBeTruthy();
      expect(tools().getAttribute('aria-checked')).toBe('false');
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

    it('lists the Orchestrator under Direct messages before its first DM, and opens one on click', async () => {
      const orchestrator = { ...ana, slug: 'orchestrator', displayName: 'Orchestrator', handle: 'orchestrator' };
      openAgentDm.mockResolvedValue({
        success: true,
        created: true,
        thread: { id: 't-orch', title: 'DM · Orchestrator', agentSlug: 'orchestrator', kind: 'dm' },
      });
      listAgents.mockResolvedValue({
        success: true,
        agents: [hermes, ana, orchestrator],
        standingDmByAgent: {},
        orchestratorSlug: 'orchestrator',
      });
      listThreads.mockResolvedValue({ success: true, threads: [] });
      await renderScreen();
      const row = await screen.findByRole('button', { name: /^Orchestrator/ });
      expect(screen.queryByText('No agents yet.')).toBeNull();
      // Other agents still wait for a DM before they get a row.
      expect(screen.queryByRole('button', { name: /^Ana/ })).toBeNull();
      fireEvent.click(row);
      await waitFor(() =>
        expect(openAgentDm).toHaveBeenCalledWith({ agentSlug: 'orchestrator', projectId: 'p1' })
      );
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
});
