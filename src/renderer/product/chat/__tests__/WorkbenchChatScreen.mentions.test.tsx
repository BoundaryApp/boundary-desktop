import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHermesChat,
  listAgents,
  listChannels,
  listMentions,
  listThreads,
  markMentionsSeen,
  renderScreen,
  setUpScreen,
  tearDownScreen,
} from './workbenchChatScreenHarness';

vi.mock('../HermesChatRuntimeProvider', () => import('./workbenchChatScreenMocks'));
vi.mock('../WorkbenchThread', () => import('./workbenchChatScreenMocks'));

describe('WorkbenchChatScreen chrome', () => {
  beforeEach(setUpScreen);
  afterEach(tearDownScreen);

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
          record({ id: 'p2:ana', text: '@Ana dates?', status: 'waiting', reply: undefined, unseen: false }),
          record({ id: 'p3:assistant', agentSlug: 'assistant', text: '@Hermes sum up', reply: { text: 'Done.', at: now } }),
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

    it('focuses the mention once: a detour and a return open the room without it', async () => {
      await renderScreen();
      fireEvent.click(await screen.findByRole('button', { name: /^Mentions/ }));
      const list = await screen.findByRole('list', { name: 'Mentions' });
      fireEvent.click(within(list).getAllByRole('button', { name: 'Open in #research' })[0]);
      expect(await screen.findByText('focus:@Ana pricing?')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));
      const all = await screen.findByRole('list', { name: 'All chats' });
      fireEvent.click(within(all).getAllByText(/research/)[0]);
      expect(await screen.findByText(/thread:#research/)).toBeTruthy();
      expect(screen.queryByText(/^focus:/)).toBeNull();
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
});
