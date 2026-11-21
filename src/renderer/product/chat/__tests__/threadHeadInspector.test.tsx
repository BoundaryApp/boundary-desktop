import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentProfile, ChannelRecord } from '../../../../shared/types/hermesChat';
import { InspectorToggleProvider, type InspectorToggleState } from '../InspectorToggle';
import { ThreadHead, type ThreadHeadProps } from '../ThreadHead';

const agents = [
  { slug: 'assistant', displayName: 'Marlow', builtIn: true },
  { slug: 'wren', displayName: 'Wren' },
] as AgentProfile[];

const channel = {
  id: 'ch1',
  slug: 'launch-prep',
  title: 'launch-prep',
  sessionId: 't-ch',
  memberSlugs: ['assistant', 'wren'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as ChannelRecord;

const base: ThreadHeadProps = {
  kind: 'channel',
  threadTitle: '#launch-prep',
  agent: null,
  agents,
  channel,
  startedAt: null,
  activeProject: null,
  filed: false,
  branchedFrom: null,
  moveDisabledReason: null,
  dmTabs: null,
};

function renderHead(props: Partial<ThreadHeadProps>, toggle: InspectorToggleState | null) {
  return render(
    <InspectorToggleProvider value={toggle}>
      <ThreadHead {...base} {...props} />
    </InspectorToggleProvider>
  );
}

describe('ThreadHead and the inspector (ADR 0069)', () => {
  afterEach(cleanup);

  it('shows a channel’s members, and clicking them opens the Room tab', () => {
    const openAt = vi.fn();
    renderHead({}, { open: false, warning: null, toggle: vi.fn(), openAt });

    fireEvent.click(screen.getByRole('button', { name: '2 members, show in details' }));

    expect(openAt).toHaveBeenCalledWith('room');
  });

  it('has no members button outside a channel, and no toggle without the chat screen', () => {
    renderHead({ kind: 'dm', channel: null, agent: agents[1] }, { open: true, warning: null, toggle: vi.fn(), openAt: vi.fn() });
    expect(screen.queryByRole('button', { name: /members/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide details' })).toBeTruthy();
    cleanup();

    renderHead({}, null);
    expect(screen.queryByRole('button', { name: /details/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /members/ })).toBeNull();
  });
});
