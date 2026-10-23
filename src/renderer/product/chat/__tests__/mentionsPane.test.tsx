import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentProfile,
  ChannelRecord,
  HermesMentionRecord,
} from '../../../../shared/types/hermesChat';
import { MentionsPane } from '../MentionsPane';

const hermes: AgentProfile = {
  slug: 'assistant',
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default',
  builtIn: true,
  createdAt: '',
};
const ana: AgentProfile = { ...hermes, slug: 'ana', displayName: 'Ana', handle: 'Ana', builtIn: false };
const room = (id: string, slug: string): ChannelRecord => ({
  id,
  slug,
  title: slug,
  sessionId: `s-${id}`,
  memberSlugs: [],
  createdAt: '',
  updatedAt: '',
});
const channels = [room('ch1', 'research'), room('ch2', 'launch')];
const mention = (over: Partial<HermesMentionRecord>): HermesMentionRecord => ({
  id: 'm',
  channelId: 'ch1',
  channelSlug: 'research',
  sessionId: 's-ch1',
  agentSlug: 'ana',
  text: '@Ana pricing?',
  at: new Date().toISOString(),
  anchor: 'p',
  status: 'replied',
  reply: { text: 'Two vendors.', at: new Date().toISOString() },
  unseen: false,
  ...over,
});
const mentions = [
  mention({ id: '1', unseen: true }),
  mention({ id: '2', channelId: 'ch2', channelSlug: 'launch', text: '@Ana dates?', status: 'waiting', reply: undefined }),
  mention({ id: '3', agentSlug: 'assistant', text: '@Hermes summary', reply: { text: 'Done.', at: new Date().toISOString() } }),
];

const renderPane = (over: Partial<React.ComponentProps<typeof MentionsPane>> = {}) => {
  const props = {
    mentions,
    agents: [hermes, ana],
    channels,
    onOpenInRoom: vi.fn(),
    onContinue: vi.fn(),
    onAskAgain: vi.fn(),
    ...over,
  };
  render(<MentionsPane {...props} />);
  return props;
};
const cards = () => within(screen.getByRole('list', { name: 'Mentions' })).queryAllByRole('listitem');

describe('MentionsPane (ADR 0023 §6)', () => {
  afterEach(() => cleanup());

  it('shows each mention with the right pill and highlights the @', () => {
    renderPane();
    expect(cards()).toHaveLength(3);
    expect(screen.getByText('New reply')).toBeTruthy();
    expect(screen.getByText('No reply yet')).toBeTruthy();
    expect(screen.getByText('Replied')).toBeTruthy();
    expect(document.querySelector('.wb-mention-at')?.textContent).toBe('@Ana');
  });

  it('filters by agent, unseen and waiting', () => {
    renderPane();
    fireEvent.click(screen.getByRole('radio', { name: /Hermes/ }));
    expect(cards()).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'All agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unseen' }));
    expect(cards()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Unseen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Waiting' }));
    expect(cards().map((c) => c.getAttribute('aria-label'))).toEqual(['Ana in #launch']);
  });

  it('locks to one agent with channel chips for the DM tab', () => {
    renderPane({ lockedAgent: ana });
    expect(cards()).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /Hermes/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '#launch' }));
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Waiting on Ana' })).toBeTruthy();
  });

  it('offers the right action per card', () => {
    const props = renderPane();
    const [replied, waiting, fromHermes] = cards();
    fireEvent.click(within(replied).getByRole('button', { name: 'Open in #research' }));
    fireEvent.click(within(replied).getByRole('button', { name: 'Continue in DM with Ana' }));
    fireEvent.click(within(waiting).getByRole('button', { name: 'Ask again' }));
    expect(within(fromHermes).getByRole('button', { name: 'Continue in a Hermes chat' })).toBeTruthy();
    expect(props.onOpenInRoom).toHaveBeenCalledWith(mentions[0]);
    expect(props.onContinue).toHaveBeenCalledWith(mentions[0]);
    expect(props.onAskAgain).toHaveBeenCalledWith(mentions[1]);
  });

  it('explains an empty list', () => {
    renderPane({ mentions: [], lockedAgent: ana });
    expect(screen.getByText('You haven’t @’d Ana in a channel yet.')).toBeTruthy();
  });
});
