import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ChannelRecord } from '../../../../shared/types/hermesChat';

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: { getAgentSoul: vi.fn().mockResolvedValue({ success: true }), revealAgentSoul: vi.fn() },
}));
vi.mock('../ProjectSourcesRail', () => ({ ProjectSourcesRail: () => null }));

import { ChannelCreateSheet } from '../ChannelSheets';
import { RightInspector } from '../RightInspector';
import { AgentRosterSheet } from '../AgentSheets';

const hermes: AgentProfile = {
  slug: 'assistant',
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default agent on this machine.',
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
};
const ana: AgentProfile = {
  slug: 'ana',
  displayName: 'Ana',
  handle: 'Ana',
  role: 'Researcher',
  builtIn: false,
  createdAt: '2026-09-22T00:00:00.000Z',
};
const ben: AgentProfile = { ...ana, slug: 'ben', displayName: 'Ben', handle: 'Ben', role: 'Editor' };
const room: ChannelRecord = {
  id: 'ch1',
  slug: 'research',
  title: 'research',
  sessionId: 's-room',
  memberSlugs: ['assistant', 'ana'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('Hermes in channels (ADR 0023 §9)', () => {
  afterEach(() => cleanup());

  it('starts a new channel with Hermes checked, first, and lets you uncheck it', () => {
    const onCreate = vi.fn();
    render(
      <ChannelCreateSheet open agents={[ana, hermes]} onCancel={() => undefined} onCreate={onCreate} />
    );
    const picks = screen.getAllByRole('button', { pressed: undefined }).filter((b) =>
      b.hasAttribute('aria-pressed')
    );
    expect(picks.map((b) => b.textContent?.replace('✓ ', ''))).toEqual(['Hermes', 'Ana']);
    expect(picks[0].getAttribute('aria-pressed')).toBe('true');
    expect(picks[1].getAttribute('aria-pressed')).toBe('false');

    fireEvent.change(screen.getByPlaceholderText('launch-prep'), { target: { value: 'Launch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ memberSlugs: ['assistant'] })
    );

    fireEvent.click(picks[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Create channel' }));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ memberSlugs: [] }));
  });

  it('adds and removes members, Hermes included, from the Room tab', () => {
    const onAddMember = vi.fn();
    const onRemoveMember = vi.fn();
    render(
      <RightInspector
        centerMode="conversation"
        kind="channel"
        activeChannel={room}
        activeAgent={null}
        agents={[hermes, ana, ben]}
        project={null}
        inspect={null}
        threadId="s-room"
        onChangeFolder={() => undefined}
        onChooseFolder={() => undefined}
        onRevealHub={() => undefined}
        onRevealSource={() => undefined}
        onRefreshIndex={() => undefined}
        onAddFolder={() => undefined}
        onRemoveSource={() => undefined}
        onMakeChannel={() => undefined}
        onAddToChannel={() => undefined}
        onAddMember={onAddMember}
        onRemoveMember={onRemoveMember}
      />
    );
    expect(screen.getByText('Default agent · reads later')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hermes from #research' }));
    expect(onRemoveMember).toHaveBeenCalledWith('ch1', 'assistant');

    const add = screen.getByRole('group', { name: 'Add a member' });
    expect(within(add).queryByText('Ana')).toBeNull();
    fireEvent.click(within(add).getByRole('button', { name: 'Add Ben to #research' }));
    expect(onAddMember).toHaveBeenCalledWith('ch1', 'ben');
  });

  it('offers Hermes for a room it is not in', () => {
    render(
      <RightInspector
        centerMode="conversation"
        kind="channel"
        activeChannel={{ ...room, memberSlugs: ['ana'] }}
        activeAgent={null}
        agents={[ana, hermes]}
        project={null}
        inspect={null}
        threadId="s-room"
        onChangeFolder={() => undefined}
        onChooseFolder={() => undefined}
        onRevealHub={() => undefined}
        onRevealSource={() => undefined}
        onRefreshIndex={() => undefined}
        onAddFolder={() => undefined}
        onRemoveSource={() => undefined}
        onMakeChannel={() => undefined}
        onAddToChannel={() => undefined}
        onAddMember={() => undefined}
        onRemoveMember={() => undefined}
      />
    );
    expect(screen.getByRole('button', { name: 'Add Hermes to #research' })).toBeTruthy();
  });

  it('lets the roster add Hermes to a channel', () => {
    const onAddToChannel = vi.fn();
    render(
      <AgentRosterSheet
        open
        agents={[hermes, ana]}
        onClose={() => undefined}
        onNewAgent={() => undefined}
        onOpenDm={() => undefined}
        onAddToChannel={onAddToChannel}
      />
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Add to channel' })[0]);
    expect(onAddToChannel).toHaveBeenCalledWith('assistant');
  });
});
