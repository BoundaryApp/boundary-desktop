import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { RightInspector } from '../RightInspector';
import type { AgentProfile } from '../../../../shared/types/hermesChat';

const getAgentSoul = vi.fn();

stubElectronAPI({
  agents: {
    getSoul: (...args: unknown[]) => getAgentSoul(...args),
    revealSoul: vi.fn(),
  },
});

const designer: AgentProfile = {
  slug: 'designer',
  displayName: 'UI/UX Designer',
  handle: 'designer',
  role: 'Own UX and visual design.',
  builtIn: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const projectTab = {
  project: null,
  inspect: null,
  connecting: false,
  rpcAvailable: true,
  onChangeFolder: () => undefined,
  onChooseFolder: () => undefined,
  onRevealHub: () => undefined,
  onRevealSource: () => undefined,
  onRefreshIndex: () => undefined,
  onAddFolder: () => undefined,
  onRemoveSource: () => undefined,
};

function renderAgent(agent: AgentProfile) {
  return render(
    <RightInspector
      centerMode="conversation"
      kind="dm"
      activeChannel={null}
      activeAgent={agent}
      agents={[agent]}
      threadId="t-dm"
      projectTab={projectTab}
      onMakeChannel={() => undefined}
      onAddToChannel={() => undefined}
    />
  );
}

describe('RightInspector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the role once, without a Soul excerpt that repeats it', async () => {
    getAgentSoul.mockResolvedValue({
      success: true,
      excerpt: 'Own UX and visual design.',
      canOpen: true,
    });

    renderAgent(designer);

    expect(screen.getByRole('button', { name: 'Agent' })).toBeTruthy();
    expect(screen.getAllByText('Own UX and visual design.')).toHaveLength(1);
    expect(screen.queryByText('Soul')).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open SOUL.md' })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('clamps a role longer than four lines behind Show more', async () => {
    getAgentSoul.mockResolvedValue({ success: true, excerpt: null, canOpen: false });
    // jsdom has no layout or line height, so the 20px fallback applies: report ten lines.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);

    renderAgent({ ...designer, role: 'A long role. '.repeat(40).trim() });
    await waitFor(() => expect(getAgentSoul).toHaveBeenCalled());

    const role = screen.getByText(/^A long role\./);
    expect(role.className).toBe('is-clamped');
    const more = screen.getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(role.className).toBe('');
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });
});
